# 27 — ACP Agent Steps

A Noetic step can delegate a turn to an external coding agent — Claude Code,
Codex, Gemini CLI, anything that speaks the protocol — exactly the way
`callModel` delegates a turn to a language model. The integration is the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP): a JSON-RPC 2.0
standard in which **Noetic is the Client and the coding agent is the Agent**.
(The other direction — a Noetic harness serving *as* the Agent for ACP clients
like Zed — is `31-acp-server`.)

Because every ACP agent is a uniform JSON-RPC peer, there are no per-vendor SDKs
and no closed set of supported agents. One step kind, one package, one adapter
shape.

## Why the protocol, not an SDK per agent

ACP is bidirectional. The agent does not reach for the machine itself: it asks
the client to read files, write files, and run terminals, and it asks permission
before running a tool. Implementing the client side means **a sub-agent's file
and shell access goes through Noetic's own adapters** rather than around them
through a vendor SDK — so a host that supplies an in-memory or virtual
`FsAdapter` genuinely constrains what the agent can touch, and the client is the
one place a boundary can be enforced at all.

That boundary is enforced here rather than left to the adapter: `fs/*` paths
are confined to the session working directory by default. Terminals are a
different matter, and the honest limit is stated below.

It also brings capabilities that have no representation in a hand-rolled
adapter: permission requests, plans, session modes, slash commands, MCP server
passthrough, multimodal prompts, typed stop reasons, and cancellation semantics.
A step's own Noetic tools reach the agent over MCP too, through the same
pipeline as a `callModel` tool call, and its context layers run around each
turn as around a model call (see `38-acp-tools`).

## Packages

```
acp ──→ types          (core never imports acp)
core ─→ types          (resolves agents via contract + registry)
```

- **`@noetic-tools/types`** — the contract: `AcpAgent`, `AcpAgentConnection`,
  `AcpSession`, `AcpTransport`, `AcpClientHost`, the permission types, and
  `StepAcpAgent`. It lives here — next to `ContextLayer` — so both `core` and
  `acp` depend on it without forming a cycle. Protocol types are re-exported
  verbatim from the official `@agentclientprotocol/sdk` (pinned to its 1.x
  line, whose `ClientSideConnection` the client is built on) rather than
  mirrored, so the wire surface cannot drift from the specification.
- **`@noetic-tools/acp`** — the protocol client: capability negotiation, the
  session/turn drivers, the client-side `fs/*` + `terminal/*` + permission
  handlers, the permission resolver, the agent presets, and the transports. Its
  `.` entry point is runtime-neutral; the Node stdio transport lives behind the
  `./stdio` subpath so a browser bundle never pulls in `node:child_process`.

## The contract

Three levels, mirroring the protocol: an agent opens a connection, a connection
carries sessions, a session runs turns.

```ts
interface AcpAgent {
  readonly specificationVersion: 'acp-v1';
  /** Free-form, e.g. 'claude-code'. An OPEN set — no enum. */
  readonly agentId: string;
  connect(opts: AcpConnectOptions): Promise<AcpAgentConnection>;
}

interface AcpAgentConnection {
  readonly agentCapabilities: AcpAgentCapabilities;
  readonly authMethods: ReadonlyArray<AcpAuthMethod>;
  readonly protocolVersion: number;
  authenticate(methodId: string): Promise<void>;
  newSession(opts: AcpNewSessionOptions): Promise<AcpSession>;
  loadSession(opts: AcpLoadSessionOptions): Promise<AcpSession>;
  /** Set when the agent can outlive this host; see § A local agent outlives its host. */
  readonly reattach?: AcpReattachHandle;
  /** On a reattached connection: the live session, with no session/new or session/load. */
  attachSession?(sessionId: string): Promise<AcpSession>;
  close(): Promise<void>;
}

interface AcpSession {
  readonly sessionId: string;
  readonly modes?: AcpSessionModeState;
  readonly configOptions?: ReadonlyArray<AcpSessionConfigOption>;
  readonly availableCommands: ReadonlyArray<AcpAvailableCommand>;
  prompt(opts: AcpPromptOptions): Promise<AcpTurnResult>;
  cancel(): Promise<void>;
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  /** On a reattached session: collect the turn the previous host left running. */
  resumeTurn?(opts: AcpResumeTurnOptions): Promise<AcpTurnResult | undefined>;
}
```

`AcpConnectOptions` carries `reattach` (reach that agent instead of starting
one) and `whenHostExits` (`'keep'`, the default, or `'stop'`); an
`AcpMachine` may offer `attach(handle)`, and an `AcpTransport` its `reattach`
handle.

A session's `modes` and `configOptions` come from the answer that opened it —
`session/new`, or `session/load` for a loaded session — and stay current:
`current_mode_update` moves `modes.currentModeId`, `config_option_update`
replaces `configOptions`. A loaded session that advertised modes therefore
takes a follow-up `setMode`, and one that advertised none still refuses it.
`setModel` selects the value of the agent's `model` config option (a `select`
with category `model`, else one with id `model`) through
`session/set_config_option`. An agent that advertises no such option is sent
the draft `session/set_model` request it may predate config options with; one
that answers "method not found" refuses it with `AcpCapabilityError`.

A capability the agent did not advertise is refused **before anything reaches
the wire**, with `AcpCapabilityError` — loading a session, switching mode or
model, sending image/audio/embedded content, or naming an HTTP/SSE MCP server.
A connection that cannot be established raises `AcpConnectError`.

An agent's own JSON-RPC rejection — of `session/new`, `session/load`, a mode or
model selection, or the prompt — fails the step with `step_failed` whose cause
reads the rejection in full: its message, its `data` detail (`data.message`,
`data.details`, or the serialized data) and its code, as in
`Internal error: Authentication required (-32603)`. A protocol error object is
never reduced to `[object Object]` or a bare "Internal error". The cause keeps
the rejection's `code` and `data`, with the original rejection as its own
`cause`, so a caller can still branch on a code such as auth-required. An
abort (a `DOMException`) is not a protocol error, and a step aborted while its
session opens fails with `cancelled`.

## Transport

ACP rides on a bidirectional byte stream:

```ts
interface AcpTransport {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}
```

`ShellAdapter` cannot carry it: a shell command runs once and returns. The
harness's `SubprocessAdapter` can, through `open` (§ The harness's machine).

An agent is reached one of two ways:

- **A command on a machine** — how every preset runs. An `AcpMachine` is opened
  once per connection, before the agent starts:

  ```ts
  interface AcpMachine {
    reach(bridge: ToolBridgeAddress): Promise<ToolBridgeAddress>;
    launch(command: SpawnCommand): Promise<AcpTransport>;
    spawn: Spawn; // (command: SpawnCommand) => Promise<AcpTransport>
    close(): Promise<void>;
  }
  ```

  `reach` carries the tool bridge (spec 38) to where the agent can use it,
  `launch` starts the agent with launch settings built from that address, and
  `spawn` starts a process beside it — a stdio MCP server that depends on that
  machine — whose stdio comes back, so Noetic stays its client. A command
  agent's `AcpAgent.spawn` is `spawnOn(machine)`; `Spawn`, `SpawnCommand` and
  `ByteStream` live in `@noetic-tools/types`, so `@noetic-tools/mcp` takes the
  same seam (`mcp({ command, spawn })`) without importing this package. Closing
  the agent's stream releases the machine.
- **A transport** — `AcpTransportFactory`, for an agent someone else started.
  It cannot carry the bridge or apply launch settings, so a step that gives it
  `tools` fails (`AcpAgent.refusesTools`):
  `ACP_TRANSPORT_CANNOT_LAUNCH` when the agent's wiring has launch settings,
  `ACP_TRANSPORT_CANNOT_REACH` otherwise. With `tools` left out it gets none.
  `gemini()` without `trustWorkspace: true` refuses tools the same way, with
  `ACP_AGENT_CANNOT_TAKE_TOOLS`: Gemini starts no MCP server in a folder it
  does not trust (`38-acp-tools` § Gemini CLI and folder trust).

### The harness's machine

Where processes run is the harness's to say, like its storage and its
filesystem. `SubprocessAdapter.open` is an `AcpMachineFactory`: the place that
adapter's processes run, for a process whose stdio the caller holds.

```ts
new AgentHarness({
  environment: {
    subprocess: { ...createInMemorySubprocessAdapter(), open: webSocketMachine({ url, token }) },
  },
});
```

A command agent runs on the first of these that is given:

1. the `machine` the agent names (`claudeCode({ machine })`);
2. the harness's `environment.subprocess.open`;
3. this machine (`localMachine`).

The core passes the harness's to `AcpAgent.connect` as
`AcpConnectOptions.machine`, on a first connection and on a reattach alike, so
a resumed step reaches the agent it left running through the same place
(§ Resuming a step) and a host writes that place once, not on every agent.

A process started beside the agent follows it. A `Spawn` takes
`{ machine }` as its second argument, and `agent.spawn` starts the process on
the agent's own machine, else on the one it is given, else here. A connection
provider is given the harness's as `ConnectOptions.machine`, and `mcp()` hands
it to its server's `spawn`, so `mcp({ command, spawn: agent.spawn })` and a
JSON `acp-agent` node's stdio `{ "mcp" }` entries start where the agent runs.
A stdio `mcp()` server given no `spawn` is a local subprocess, as before.

An adapter with no `open` — the in-memory and local adapters — leaves every
agent on this machine.

| Machine or transport | Use |
|---|---|
| `localMachine(agentId?, { keeper?, detachedTimeoutMs?, wrap?, onStderr?, onLaunch? })` (`@noetic-tools/acp/stdio`) | This machine. `launch` starts the agent through its keeper (§ A local agent outlives its host), `reach` serves the bridge on the keeper's own loopback port, `attach` reaches a kept agent again; `spawn` starts a child process. `keeper: false` (or no keeper script on disk, as in a single-file bundle) starts the agent as a child process and `reach` returns the bridge's own address. The default for every preset, loaded through a lazy `import()`. |
| `webSocketMachine({ url, token, ca? })` (`@noetic-tools/acp/remote`) | A remote runner over WebSocket. Every upgrade carries the runner's bearer token; `ws://` is refused except to a loopback host, so a hop off the machine is TLS. |
| `commandMachine({ command, args })` (`@noetic-tools/acp/remote`) | A remote runner started by a local command and spoken to over its stdio: `ssh host npx -y @noetic-tools/acp serve --stdio`, `docker exec -i ctr noetic-acp serve --stdio`. The command's own channel carries everything. |
| `runnerMachine(openLink)` (`@noetic-tools/acp/remote`) | A remote runner over any `FrameLink`. |
| `loopbackMachine(toAgent)`, `loopbackTransport(toAgent)` | An in-process agent over the real wire protocol, with no process — the way to test an ACP-backed step. The machine is reached where the bridge listens. |
| `stdioAcpTransport` (`@noetic-tools/acp/stdio`) | An attached child process. |
| custom transport | Anything yielding a duplex byte stream to an agent already running. |

**A local agent's process tree.** Agents are usually started through a wrapper
— `npx`, or a Node launcher that runs a native binary as its child — so the
process Noetic spawns is rarely the agent itself. The keeper, and
`stdioAcpTransport` and a `localMachine` without one, start every process as the leader of its own process group
(POSIX) and, when the transport closes or its signal aborts, stop the whole
group: end its stdin, `SIGTERM`, a two-second grace period, then `SIGKILL`; on
Windows, `taskkill /T /F` on its tree, even when the immediate child already
exited, so its descendants still stop. A leader that exited but is not yet
reaped makes its group refuse signals (EPERM on macOS); shutdown then waits for
it to be reaped rather than failing. A child that is not a group leader is
signalled itself. `localMachine().close()` stops everything it started in
parallel. Every wait is bounded, so an
uncooperative child cannot hang the host, and our ends of the pipes are
released last, so a grandchild that inherited them cannot keep the host alive.
`close()` is idempotent — every call shares one shutdown. A missing binary, or
a signal already aborted, rejects when the transport is opened, with
`AcpConnectError`, not later at `close()`. A descendant that leaves the group
(`setsid`) is outside this and must manage its own lifetime. A host that spawns
the agent itself — a sandbox-wrapped command, a transport that rewrites lines —
gets the same shutdown from `stopProcessTree(child, { graceMs? })`
(`@noetic-tools/acp/stdio`), given a child spawned with `detached: true`.

**A wrapped launch.** A host that must start the agent its own way — inside a
sandbox (`sandbox-exec`, `bwrap`), with an environment it built, from a
binary it ships — keeps the machine and changes the command:
`localMachine(id, { wrap })`. `wrap(command, { bridges, agentEnv })` runs just before
the agent starts. It receives the command the preset built, with `env` already
the complete environment the agent would get (this process's, plus the
preset's and the tool wiring's), `agentEnv` — the preset's and the wiring's
variables alone, for a wrapper that builds the agent's environment itself —
and the bridge addresses `reach` handed out,
so a sandbox can let exactly those loopback ports through. The command it
returns runs with exactly its own `args`, `env` and `cwd` — nothing is merged
back in — as the leader of its own process group, through the keeper or not,
with the shutdown above. `onStderr` receives the agent's stderr, which
otherwise goes to the host's. `onLaunch` is told of each agent the machine
starts as its own child, once it runs — `{ pid, exited }`, where `pid` leads
the agent's process group and `exited` settles when that process has exited
— so a host that keeps a list of its processes, or stops what is left when
it shuts down, learns them. It needs `keeper: false`: a kept agent is its
keeper's child and is not reported, nor is an MCP server. The launch waits
for a promise it returns; if it throws or its promise rejects, the agent is
stopped and the launch fails.

### A local agent outlives its host

A coding agent's turn can run for a long time, and the host process that
started it can die in the middle — a crash, Ctrl-C, a deploy. By default the
agent keeps working, and a resumed run takes it over where it is, with
everything it did meanwhile.

**The keeper.** `localMachine()` starts each agent through a keeper: a small
Node process (`@noetic-tools/acp`'s `keeper/main`), detached into its own
session and process group so the host's Ctrl-C or crash does not reach it. The
keeper owns the agent's stdio and serves the host over a private local socket —
a Unix socket in a directory only its user can open (`<tmpdir>/noetic-acp-<uid>`),
or a named pipe on Windows — which every connection must open with the keeper's
token. It also owns the loopback port the agent reaches the tool bridge on
(spec 38), so the bridge address and token the agent was configured with stay
valid when a later host serves the bridge. The agent's stderr reaches the
attached host's stderr, and the keeper's log while none is attached.

**What the keeper relays.** Between the agent and the attached host it is an
ACP relay: it rewrites every host request id to its own, so an answer meant
for a host that went away is never delivered to the next one; answers
`initialize` from its cache after the first; and keeps, per session, the modes
and config options the agent advertised, every update of the turn in flight,
updates sent while no host held the session, the requests the agent is still
waiting on, and a turn result no host was there to take.

**When the host goes away** without closing the connection, the keeper
detaches and, under `whenHostExits: 'keep'` (the default), lets the agent work
on: its updates are kept, its permission, `fs/*` and `terminal/*` requests wait,
and the bridge port holds the agent's tool calls until a host serves the bridge
again (a call that was mid-way in the dead host fails with `502`). A kept agent
with no host is stopped after `detachedTimeoutMs` only when one is set; by
default (`0`) there is no limit, and it runs until a host reattaches and closes
it, or it exits. Under `'stop'` the keeper stops the agent's whole tree as soon as the
host's connection drops, whatever ended the host. Closing the connection
(`close()`, a step's `keepAlive: 'step'` ending, `harness.close()`)
always stops it. The agent exiting stops the keeper.

**Reattaching.** A connection that can be reattached carries
`AcpAgentConnection.reattach`: JSON naming the keeper (socket address and
token) and the bridge's path and token. `agent.connect({ reattach })` reaches
the same agent through its keeper, serves the bridge again under the same path
and token at the same address, and returns a connection whose
`attachSession(sessionId)` gives the live session with the modes and config
options the agent last advertised — no `session/new` or `session/load`. Its
`resumeTurn()` hands the session to this host: every update of the turn in
flight arrives again, from the first, as this turn's output (not as replay),
then each request the agent is still waiting on is asked again and answered by
this host's handlers, and then the turn's result — at once if the agent
finished while no host was attached, or when it does. With no turn running it
resolves `undefined`. A keeper that is gone, or an agent with no such session,
rejects with `AcpConnectError`.

**A durable run** stores the handle with the step's session record
(§ Resuming a step), so a resumed step reattaches before it tries anything
else.

**`killAgentsOnExit`** on the harness asks every agent it starts for
`whenHostExits: 'stop'`: a kept agent stops when its host's connection drops,
and an agent started directly (a `transport`, or a `localMachine` without a
keeper) has its process group killed when the host process exits normally — a
host killed by a signal cannot run that, and such an agent sees its stdin close
instead.

**Presets.** `claudeCode()` and `codex()` launch the maintained bridges,
`npx -y @agentclientprotocol/claude-agent-acp` and
`npx -y @agentclientprotocol/codex-acp` (`PRESET_COMMANDS`); the retired
`@zed-industries/claude-code-acp` and `@zed-industries/codex-acp` are never
started. A preset's `args` are appended after the bridge's own, its `env` is
layered onto the process environment (`CODEX_PATH` picks the Codex backend the
bridge runs), and the session's `cwd` is the process's working directory. A
`transport` override replaces the launch entirely and still receives the
preset's environment and the connection's signal. A preset never changes the
model a step or its environment selects.

**Subagents through the keeper.** A subagent runs as a child session. When
the agent announces a child on a session the keeper knows — `subagent_update`
naming the child's `sessionId`, or codex-acp's earlier draft
`subagent_spawned` naming `subagentSessionId` — the keeper records the child
as belonging to that session's root; a child announced on a child belongs to
the same root. Everything the agent sends that names a descendant — its
`session/update`s and its requests to the client (`session/request_permission`,
`elicitation/create`, `fs/*`, `terminal/*`) — is kept with its root: sent
live only to the host that holds the root, held while no host does, kept in
the one ordered record of the root's turn, and sent again with the root's
waiting requests when a host takes the turn with `_noetic/keeper/turn`. Each
line is sent as the agent wrote it, so session ids are preserved, and the
host's answers reach the agent by request id. A host that takes the root —
by `_noetic/keeper/turn` or by prompting it — is first sent the latest
announcement of each child the keeper knows under it, in the order they were
first announced (a parent before its children), even when the turn's record
repeats one, so a child an earlier turn started is placed before its traffic
arrives. Updates for a session the
keeper cannot place yet are held — a bounded number per session and a bounded
number of sessions — and placed in order once the session is announced or
becomes known; they are dropped if it never is. A request from a session the
keeper cannot place is asked of every host that attaches until it is
answered, and moves to its root's waiting requests if the session is
announced later, so the agent never waits on a host that was not asked. The
keeper remembers at most a thousand descendants; past that it forgets the
one heard from least recently (announced or speaking), never one with a request still waiting nor one a kept descendant was
announced under (its chain must stay whole) — those may keep it over the cap
until their requests are answered, and are trimmed then. A child's
waiting requests become its root's before anything is trimmed.

### The remote runner

`noetic-acp serve` (the `@noetic-tools/acp` bin, Node) runs on the agent's
machine and serves one host per channel — a WebSocket, or its own stdio with
`--stdio`. When the channel closes, the MCP servers it started stop; the agent
is kept (§ A runner keeps its agents). Over that one
channel, as JSON frames (`HostFrame` / `RunnerFrame`):

- `keep` (first, from a host that keeps agents) says agents launched over this
  channel run through a keeper, and what `whenHostExits` asks;
- `start` runs a process (the agent, or an MCP server beside it) and carries
  its stdin, stdout and exit; a kept agent's `started` carries its reattach
  handle;
- `attach` carries the stream of an agent an earlier channel launched, from
  that handle;
- `reach` opens a port on the runner's loopback interface; each HTTP request
  the agent sends there travels to the host, which answers it from its own
  bridge only — a request for any other path is `404`, and the host forwards
  the parsed path to the bridge's own origin, never the raw one. The bridge
  still checks the bearer token, `Host`, and `Origin` itself.

So the agent needs no route back to the host, and the one channel is the only
network hop. This one design covers ssh (`commandMachine` over `ssh`),
containers (`docker exec -i`) and WebSocket, in place of an ssh reverse
forward or a container host-gateway address.

#### A runner keeps its agents

A runner keeps the agents a host launches through it exactly as a local
machine does (§ A local agent outlives its host): after a `keep` frame, it
launches each agent through a keeper on the runner's own machine, and serves
the bridge to it on the keeper's port, which forwards to the channel's port
while a channel is open. When the channel drops — the host died, the network
went, an ssh session ended — the runner lets the keeper go without stopping it,
so the agent keeps working under the keeper's `whenHostExits`, and holds what
it sends. A `--stdio` runner exits with its channel; the keeper, in its own
session, does not.

A later host reconnects with `machine.attach(handle)`: over a new channel —
to the same WebSocket runner, or through a new `--stdio` runner on the same
machine and user — an `attach` frame makes the runner connect to that keeper
and carry the agent's stream, and the host's `reach` points the keeper's port at
the new channel. From there it is the local reattach: `attachSession`, then
`resumeTurn`. The runner connects only to a keeper socket in its own user's
keeper directory, and the keeper still demands its token. A runner that keeps
no agents never answers `attach`; the host gives up after ten seconds with
`AcpConnectError`. `--detached-timeout <ms>` (`AcpRunnerOptions.detachedTimeoutMs`)
bounds how long a kept agent may run with no host; the default is no limit.

The runner listens on `127.0.0.1` by default; any other address needs
`--tls-cert` and `--tls-key`. Its token comes from `NOETIC_ACP_RUNNER_TOKEN`
(or is made up and printed). `--cwd` sets the working directory for a start
that names none; a working directory missing on the runner's machine is an
error.

Without an allowlist the runner starts whatever the host asks. `--agent <id>`
grants that preset's command (`PRESET_COMMANDS`) with the environment names
its tool settings set (`PRESET_ENV`); `--spawn <command line>`, repeatable,
grants a command for an MCP server beside it (split on spaces); `--env <name>`,
repeatable, adds a name every grant may set — an API key, a server's token.
With any grant (`AcpRunnerOptions.allow`) a start must match one by executable
and arguments, may set only that grant's names — so a launcher such as
`NODE_OPTIONS`, `LD_PRELOAD` or `PATH` is refused unless granted — and runs in
a directory inside `--cwd` (the runner's own directory by default), compared
by real path, so neither `..` nor a symlink leads out. A refused start is an
`error` frame naming why. A setting that names a command the agent
starts is held to the allowlist as well: every `mcp_servers` entry with a
`command` in a `CODEX_CONFIG` must match a grant, setting only that grant's
names, and `notify` is refused; for pi, the `--agent pi` grant sets
`PI_ACP_PI_COMMAND` (the runner's own launcher) and `NOETIC_PI_COMMAND` (its
own `NOETIC_PI_COMMAND`, else `pi`) itself, over what a host sends
(`AcpRunnerGrant.fixedEnv`). The allowlist bounds what the runner starts, not
what the agent does once started: any agent runs what the host's permission
answers let it. The runner trusts whoever holds its token or its stdio, and
warns so on stderr when it starts.
`spawnOn(machine)` opens a machine per process, for a stdio MCP server that
must run where the agent runs. Such a server starts as the MCP SDK starts a
local one: with that machine's `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and
`USER` plus its own `env`, never the rest of the machine's environment
(`localMachine()` and the runner alike). Only the agent `launch` starts gets
the whole environment.

## Client-side capabilities

`@noetic-tools/acp` implements the ACP `Client` interface against an
`AcpClientHost` the runtime builds from `Context`:

| ACP client method | Backing |
|---|---|
| `fs/read_text_file` | `ctx.fs.readFileText`, with the spec's 1-indexed `line`/`limit` window |
| `fs/write_text_file` | `ctx.fs.writeFile`, parent directories via `ctx.fs.mkdir` |
| `terminal/create`·`output`·`wait_for_exit`·`kill`·`release` | A terminal registry over `ctx.shell.exec`: `onData` feeds an `outputByteLimit` ring buffer, one `AbortController` per terminal backs `kill`, and `ShellExecResult.exitCode` becomes the exit status |
| `session/request_permission` | The permission resolver (below) |
| `elicitation/create` | A held question (§ Questions the agent asks) |
| `session/update` | The event bridge (below) |

Advertised `ClientCapabilities` are computed from what the host can actually
back, narrowed by the step's `clientCapabilities`. A withdrawn capability is
answered with a JSON-RPC method-not-found rather than quietly doing the work
anyway.

Withdrawing `writeTextFile` alone does not make a step read-only: a shell
redirect through `terminal/create` writes just as well. A genuinely read-only
step withdraws both, as the docs example does.

## Filesystem confinement

ACP puts boundary enforcement on the client, and a `permissions` policy does not
serve that purpose: it answers `session/request_permission`, which covers the
agent's *tool calls*, while `fs/*` and `terminal/*` are client methods the agent
invokes directly. An agent that never asks is never gated by a policy, however
strict. So the boundary lives in the client.

By default an agent reaches the session working directory and nothing else.
`fs/read_text_file` and `fs/write_text_file` reject, before touching the
`FsAdapter`:

- any path outside the allowed roots,
- `..` traversal out of them, including forms that land outside after
  normalization,
- a sibling directory that merely shares the root's name prefix
  (`/workspace-secrets` is not inside `/workspace`),
- relative paths — the specification requires absolute ones, so a relative path
  is malformed input rather than something to resolve against a guessed base.

`clientCapabilities.additionalDirectories` widens the set;
`clientCapabilities.allowAnyPath` removes it. `terminal/create` confines its
starting `cwd` the same way.

**Limits, stated plainly.** The check is lexical: a symlink inside the workspace
pointing outside it is not caught, because resolving that requires the
filesystem and this layer stays runtime-neutral — a host that needs it supplies
an `FsAdapter` that resolves and re-checks. A terminal command can `cd` anywhere
the host user can once it is running, so the only hard boundary for shell access
is `clientCapabilities.terminal: false`. Confinement narrows what a
cooperative-but-careless agent reaches; it is not a security sandbox against a
hostile one, which needs a real sandbox behind a transport.

### Observing client-side activity

Every `fs/*` and `terminal/*` call an agent makes is reported to the runtime as
an {@link AcpClientActivity} and emitted as the generic `workspace_access`
framework event — what a step did through the host's file and shell adapters —
whether it was served or refused:

| ACP method | `operation` |
|---|---|
| `fs/read_text_file` | `read_file` |
| `fs/write_text_file` | `write_file` |
| `terminal/create` | `run_command` |
| `terminal/output` | `read_output` |
| `terminal/wait_for_exit` | `wait` |
| `terminal/kill` | `kill` |
| `terminal/release` | `release` |

Data: `{ stepId, operation, path?, command?, terminalId?, allowed, reason? }`.
A subagent's calls are its nested agent's, scoped (spec 08 § Nested agents). This is an *observed* record rather
than the agent's self-report: a `tool_call` update says what the agent claims it
did, while this says what it actually asked the client to do — and a refusal is
the more interesting record of the two, being the moment an agent reached for
something it was not allowed to have.

Its scope is the client boundary. Work done entirely inside the agent's own
process is invisible to it, as is whatever a terminal command does once
running.

## Permissions

`session/request_permission` is a baseline client responsibility. Noetic answers
in three tiers; the first decisive one wins:

1. **The step's `permissions` policy** — declarative rules matched on ACP
   `ToolKind` and tool title. `deny` is checked before `allow`, so an explicit
   refusal always beats a broad grant.
2. **Steering** — the same `beforeToolCall` pipeline that governs first-party
   tool calls, so one rule set covers both. Steering is a **veto** tier: its
   `allow` is returned both when a rule permits the call and when no steering
   hook exists at all, so only a non-allow decision is acted on. Anything else
   abstains.
3. **`onPermissionRequest`** — an async handler, the human-in-the-loop hatch
   that steering's synchronous predicate cannot express.

When all three abstain and the policy names no `default`, the request goes to
the harness's approval seam (`08-runtime` § Held tool calls): the
`approveToolCall` approver decides, and with none the request is held until
a decision passed to `harness.execute()` answers it. The agent's process is waiting on the answer,
so the turn stays live while it is held. A policy that names a `default` has
decided, and the seam is not asked.

Where there is no seam, the policy `default` applies — **`deny` unless the step
says otherwise**. An unattended agent must not gain blanket approval by
omission.

The resolved decision is translated into one of the `PermissionOption`s the
agent actually offered, honouring `persist` to prefer the `*_always` variants.
If the agent offered nothing matching the decision, the request is cancelled
rather than answered with an option meaning something else.

## Steps

One `Step.kind` (`'acp-agent'`), one builder, one interpreter handler
(`executeAcpAgent`). The agent is supplied as an adapter, so adding an agent
never touches core or the published JSON Schema.

```ts
import { step } from '@noetic-tools/core';
import { claudeCode } from '@noetic-tools/acp';

const review = step.acpAgent({
  id: 'review',
  agent: claudeCode({ env: { ANTHROPIC_MODEL: 'claude-opus-4-8' } }),
  prompt: (ctx) => 'Review the diff and summarize risks',
  mode: 'plan',
  permissions: { default: 'deny', allow: [{ kind: 'read' }] },
  clientCapabilities: { writeTextFile: false },
  output: ReviewSchema, // optional structured output
});
```

`executeAcpAgent` mirrors `executeCallModel`: it appends the prompt as a user
item, opens (or reuses) a connection and session, applies `mode`/`model`, drives
one `session/prompt`, forwards each notification to the event bridge, appends
the turn's items to the item log, charges `ctx.tokens`/`ctx.cost`, records
`ctx.lastStepMeta`, tears the connection down per policy, and returns the
agent's final message — the text after its last tool call, as `callModel`
returns its final message — or the parsed `output`.

### Tools

`tools` takes what a `callModel` step's `tools` take: `tool()` definitions,
connection entries — `mcp({ name, … })` — and picks —
`connectionTools('linear', { ops })` by name, or from a handle or entry —
with the same meaning (`35-connections` § Attaching connections, spec 38).
Eager entries connect with the turn, found by the same walk that finds a
`callModel` step's, so their tools are in the turn's set before the agent
launches. With no `tools` the agent gets the whole set, connection tools
included; `tools: []` gives it none.

Noetic is always the MCP client. Every tool reaches the agent through noetic's
tool bridge by its harness name (`<name>_<op>`, `<name>_ops` / `<name>_call`,
merged profile tools with `target`), and every call passes the same gates as a
`callModel` tool call; credentials stay with the host. A server is never handed
to the agent's own MCP client.

A connection tool's idempotency key is `<execution>:tool:<callId>`, where
`callId` is the agent's own id for the call (`ToolExecutionContext.callId`), as
it is the model's call id on `callModel` (`35-connections` § Durability).

A stdio server that must run where the agent runs is `mcp({ name, command,
args, env, spawn: agent.spawn })`: `AcpAgent.spawn` — `spawnOn(machine)` for a
preset — starts it there and carries its stdio back to noetic. Because nothing
reaches the agent's own MCP client, an agent whose adapter drops a
`session/new` server list — pi-acp does — still gets the tools.

### Prompt content

`prompt` carries plain text; `content` carries the full ACP `ContentBlock[]` —
images, audio, resource links, embedded context — appended after it. The
specification requires clients to restrict content to what the agent advertised,
so an unsupported block raises `AcpCapabilityError` before the turn is sent.

An empty `prompt` means "use the step's runtime input as the prompt".

### A host does not need to know a step is an agent

A host runs a workflow; whether one of its steps is a model call or a coding
agent is the workflow's business. So an ACP step meets the host only through
the concepts every step uses: its input is a prompt and `instructions`, its
questions to a person are held calls (`08-runtime` § Held tool calls), its
output is the harness's ordinary events and items, and its failures are
Noetic errors. What is agent-specific — which binary, which vendor options —
is the agent adapter's, set up once, like a model provider.

### Instructions

`instructions` gives the session trusted instructions, as `callModel`'s
`instructions` does: an eager string or a `(ctx) => string | undefined` getter
(a string in a JSON `acp-agent` node). They are **added to** the agent's own
system prompt, never in place of it: the agent keeps its own identity, tools
and safety prompt. A blank value is no instructions.

They go to the agent when the step opens its session (`session/new`, or
`session/load` on a resume):

- as the protocol's `systemPrompt` (`{ mode: 'append', content: [text] }`)
  when the agent advertises `sessionCapabilities.systemPrompt`;
- otherwise through the adapter's own extension, when it has one:
  `claudeCode()` sends claude-agent-acp's `_meta.systemPrompt.append`, which
  bridges that predate the capability read (`defineAcpAgent({
  instructionsMeta })` declares one for any agent);
- otherwise the step fails with `NoeticConfigError`
  `AGENT_CAPABILITY_MISSING` before the request goes out. Instructions are
  never silently dropped.

**Vendor session options belong to the adapter.** An agent may read options of
its own from a session request's `_meta` (Claude Code's
`{ claudeCode: { options } }`). Those are set where the agent is set up —
`claudeCode({ sessionMeta })`, `defineAcpAgent({ sessionMeta })` — and sent on
every session the adapter opens; a step's `agent` may be a `(ctx) => AcpAgent`
getter, so a host can build one per run. The step itself names no vendor, and a
JSON document cannot carry `_meta`. The adapter's extension for instructions
and its `sessionMeta` merge into one `_meta`; a key `sessionMeta` sets wins.

**What a session was opened with.** Instructions, `_meta`, the working
directory, the tools and the client capabilities are fixed when a session
opens. The connection keeps a fingerprint of what it actually sent — the
request's instructions and `_meta`, cwd and MCP server names, the advertised
client capabilities, and what else the agent was set up with when the
connection opened: the tools the bridge serves (names, descriptions, schemas),
the bridge's name, and the client's path rules — never an address or token
that changes from host to host
(`AcpSession.fingerprint`), and can say what it would send for a step
(`AcpAgentConnection.fingerprintFor`). A step that reuses a live session
(`session.reuse`) with a different fingerprint fails with
`ACP_SESSION_SETTING_CONFLICT`; so does a resumed step that reattaches to a
session whose stored fingerprint differs from its own (§ Resuming a step).
Fingerprints compare canonical JSON, so key order is no difference.

### Questions the agent asks

An agent may ask the user for input mid-turn (`elicitation/create`, a form or a
URL) — claude-agent-acp presents Claude Code's `AskUserQuestion` this way. It
is a question for a person, so it goes where every such question goes: the
harness holds it (`08-runtime` § Held tool calls) as a **held question**.

- It is announced with `tool_call_held`, listed by `pending()`, and put to the
  harness's `onHeld`, with `reason: 'question'`, `name` `<agentId>:question`,
  and `question: { message, schema?, url? }` (the form's JSON Schema, or the
  URL to open).
- A `{ output }` decision answers it: the agent gets `accept` with that
  content. An output that does not match `schema` is refused (`hold_refused`)
  and the question stays held. A field's choices (`enum`, `oneOf`/`anyOf`
  consts, and their `items` forms) are suggestions, not a limit: a person may
  always type an answer of their own, and the agent decides what to make of it. `{ action: 'deny' }` declines it: the agent
  gets `decline`.
- Settled any other way — its turn aborted or interrupted, a deadline, a steer
  applied at the `held` point, the harness closed — the agent gets `cancel`.
- The agent's process is waiting on the answer, so the turn stays live while
  the question is held (it does not park).
- Its id is made from the step's dispatch path and a hash of the request with
  the agent's own JSON-RPC id for it, which a keeper keeps when it asks a
  reattached host again. The client reads that id off the wire and carries it
  in the request's own `_meta` to the handler, so it cannot drift onto another
  request; where it is unknown, the request's ordinal among identical ones
  stands in. An agent that asks again under an id this host already asked
  under is asking a new question. The answer is kept until the step ends, not
  dropped once taken, so a host that died after taking it and before the agent
  got it is not asked again: the resumed host finds the question answered.
- An agent's form is closed: the agent takes only the fields it described, so
  the held question's `schema` says `additionalProperties: false`, and an
  answer with any other field is refused before the question settles.

The client advertises form elicitation (`elicitation: { form: {} }`) by
default — asking is gated, never opted into — and URL elicitation never, since
nothing here opens a URL. `clientCapabilities.elicitation: false` withdraws it,
and the agent then cannot ask: a question it asks anyway is answered `cancel`
without reaching anyone. A JSON `acp-agent` node takes the same flag,
within the host's grant: `elicitation` is granted by default
(`AcpCapabilityGrant.elicitation`), and a host with nobody to answer grants
`false`.

**A served run** (spec 31) has a person on the other end of the wire: each
question its turn holds is put to the editor as `elicitation/create` when the
editor advertised form elicitation, its answer passed back as a decision
(`accept` → the output, `decline` → `deny`, `cancel` → left held), and
declined at once when the editor cannot show forms, fails the request, or
gives an answer the question refuses. A served turn never waits on nobody.

### Subagents

An agent may run subagents as child sessions of the step's session (the ACP
subagents RFD: `subagent_update` announces a child; codex-acp's earlier draft,
`subagent_spawned`). The client always advertises `subagents: {}`, so an agent
runs each subagent in its own session; there is no setting to have a
subagent's work mixed into the step's output instead.

Only the step's own session produces the step's output. Each child becomes a
**nested agent** of the turn (`08-runtime` § Nested agents): its updates go
through the same event mapping as the step's, with a `scope` naming it, so
its text, reasoning and tool calls reach the full stream as its own — never
the step's text, items or result. Its announcement registers it — the RFD's
`title` and `description`, or the draft's `name` and `task`, and its state —
and every update the connection hands on carries the child's lineage, its
chain of announced parents. It opens (`agent_started`) on its first activity
in the turn — an update, a request, a call — under that whole chain, so a
child announced by a child is nested under it (`parentId`) even when the
grandchild speaks first, and a child that only reappears in a replayed
announcement shows nothing. Each state it reports is an `agent_status`
(`running`, `idle`, `requires_action` as `waiting`, `unknown`), and the end of
the turn closes it (`agent_completed`: `cancelled` or `failed` when its last
stop reason said so, else `completed`). The child's messages (the RFD's
`session_message` and `session_message_chunk`) are kept by `messageId` as the
RFD defines them: an omitted or null sender or recipient keeps the one known,
omitted content keeps it, null clears it, an array replaces it, and a chunk
appends a block. A message sent to the child by another session is its
input, a scoped user message (text and media as content parts, a resource as
the text that names it), shown once when the child starts on it or the turn
ends; its `messageId`, when it is one of the turn's calls and the message is
what opens the child, is `agent_started`'s `callId`. `capabilities.cancel`
grants a stop only as an object; omitted or null grants none. A child announced with
`capabilities.cancel` is `cancellable`: `AcpSession.cancelChild(sessionId)`
sends `session/cancel` for it alone, which `harness.stopAgent` uses. It
refuses (`AcpCapabilityError`) any other id — the session itself, another
session of the connection, a child below another session, one not announced
as cancellable — since `session/cancel` for those would stop a turn. A connection remembers at most a
thousand children, forgetting the one heard from least recently first — the
order the keeper keeps, so a child still speaking is never forgotten — but
never one another kept child was announced under, so a child is never placed without its parent. Updates for a session the connection does not
know are dropped; an update that arrives before the connection knows whose
it is — the agent's first updates for a session it creates, sent before its
`session/new` answer, or a child's sent before its announcement — is held (at
most 1000) until the session is known, then routed again in order: a child
announced early is still a child, and its early updates are its own. A
failed `session/load` forgets the session and every child it announced.
While a session is loaded, its children's replayed updates are history and
are not shown.

### Failures are Noetic errors

Whatever goes wrong reaches the host as a Noetic error, both from `execute()`
and on the event stream (the turn's `response.completed` with an `error`
reason carries the same error):

- a missing capability the step needs (prompt content, a mode, a model,
  instructions) is `NoeticConfigError` `AGENT_CAPABILITY_MISSING`, naming the
  capability;
- an agent that cannot be started or reached, that dies, or that rejects a
  request is `NoeticError` `step_failed`, its message the agent's own
  (`Internal error: Authentication required (-32603)`), the original in
  `cause`;
- a configuration conflict keeps its `ACP_*` code: those are the workflow
  author's, about a step they wrote as an agent step.

### Conversation history

An ACP session owns its history on the agent side, but a freshly opened session
knows nothing about the Noetic steps that ran before it. Before appending this
turn's prompt, `executeAcpAgent` captures the prior items from `ctx.itemLog` and
folds them into the first prompt of a **fresh** session as a transcript
preamble, so a coding agent running after a chain of `callModel` steps
understands what was already established. A reused session is not re-seeded.

### Stop reasons

| `StopReason` | Outcome |
|---|---|
| `end_turn` | Normal return |
| `max_tokens`, `max_turn_requests` | Normal return; the reason is recorded on `ctx.lastStepMeta` |
| `refusal` | `NoeticError` kind `model_refused` |
| `cancelled` | `NoeticError` kind `cancelled` |

Aborting the step's context sends `session/cancel`; per the specification the
agent still answers the original `session/prompt` with the `cancelled` stop
reason, which the handler turns into the typed error.

### Session reuse and lifetime

A connection owns a live agent — usually a child process whose stdio keeps the
event loop alive — so **keeping one is never inferred**. `session.keepAlive`
names the scope, and it defaults to closing with the step:

| `keepAlive` | The connection is |
|---|---|
| `'step'` (default) | closed when the step finishes |
| `'run'` | kept for the rest of the root run, then closed by the harness |
| `'harness'` | kept until the caller runs `harness.close()` — nothing closes it for you |

`session.reuse` shares a kept connection under an id, so later steps take their
turns against the same agent. It requires `keepAlive: 'run'` or `'harness'`: a
connection closed at the end of its step has nothing left to share, so naming a
reuse key without a scope raises `ACP_REUSE_WITHOUT_KEEPALIVE` rather than
silently upgrading the scope on the step's behalf.

```ts
// Shared for the rest of this run, collected automatically.
session: { reuse: 'bugfix', keepAlive: 'run' }

// Kept past the run — a warm agent across several harness.execute() calls.
// The caller owns it: `await harness.close()` when done.
session: { reuse: 'assistant', keepAlive: 'harness' }
```

`session.load` resumes an existing ACP session id via `session/load` instead of
creating a new one. The agent replays the loaded conversation as
`session/update` notifications before it answers; see § Output → harness events
for how that replay is told apart from the new turn.

### Resuming a step

An ACP step is cut off like any other: the host dies while the agent works. On a
durable run (`23a-step-level-resume`) the step keeps two things so a resume does
not start the agent's work over.

**The agent's session.** When the step opens a session it stores the session id,
its fingerprint (§ Instructions) — and, when the agent can outlive its host,
its reattach handle — with the run's
pending entries, under `execution:<root id>:pending:<step path>/acp-session`,
and removes it when the step finishes. A resumed step that finds one, written by
the same agent id:

0. with a reattach handle, reaches the agent that kept working (§ A local agent
   outlives its host), on the machine a first connection would use (§ The
   harness's machine), and attaches to the live session. Its first turn collects
   the turn the dead host left running — every update of it as this step's
   output, the requests the agent still waits on answered by this host, then its
   result — instead of prompting. Only when no turn was running does it prompt,
   behind `ACP_RESUME_NOTICE`. When the agent or its session is confirmed gone
   — an `AcpConnectError` with `gone: true`: the keeper's socket is missing or
   refuses, the keeper runs no agent, or the agent has no such session — it
   goes on as below. Any other failure fails the step, since the old turn may
   already have changed things. Before it collects anything it compares the
   session's stored fingerprint with the step's (§ Instructions): a different
   one fails the step with `ACP_SESSION_SETTING_CONFLICT`, and the host lets
   go of the agent (`AcpAgentConnection.detach`) rather than stopping it, so a
   host that resumes with the settings it started with can still take the
   turn. Letting go tells the keeper so (`release`): the agent keeps running
   whatever exit policy this host's hello set. Every failure before the host
   adopts the agent — the bridge, the handshake — lets go the same way. A record written before fingerprints were kept has none and is
   accepted; a reattached session keeps its stored fingerprint for later
   reuse, and a reloaded one is stored with the fingerprint it was reloaded
   with.
1. connects, and when the agent advertises `loadSession` calls `session/load`
   with the stored id. The `session/update` notifications the agent replays
   while it loads are its history, not this turn's work: they reach only
   raw-event consumers, marked `replay: true` (§ Output → harness events).
2. sends the step's prompt behind a notice that the previous turn was cut off
   and that finished work is not to be redone (`ACP_RESUME_NOTICE`). The
   conversation history is not prepended: the session has it.

An agent that does not advertise `loadSession`, or that fails the load because
it no longer has the session (JSON-RPC `-32002`, and nothing else), gets a new session and the prompt with the conversation
history, as on a first run, and the new id replaces the stored one. Any other
failure of the load fails the step rather than starting the work over. A failed
load leaves nothing tracked on the connection.
A step that names `session.load` itself keeps no record: its session is the
caller's.

**The tool calls it made.** Each call the agent makes through the tool bridge is
recorded in the step ledger as it finishes (`38-acp-tools` § Replay), so an
agent that makes a call again on resume, in a reloaded session or a new one,
gets the result it got the first time and the tool does not run.

What a resume cannot recover is work the agent did with its own tools and its
`fs/*` and `terminal/*` calls: those are the agent's, and it is the agent,
reading its reloaded session, that decides not to repeat them.

**A kept connection holds the turn's connections.** Its agent may call a step
entry's tools on a later turn, so a connection kept past its step
(`'run'` or `'harness'`) holds what the turn attached (`registry.hold`) and
releases it when the connection closes. A `'step'` connection holds nothing:
the turn releases its entries when it ends.

**Per-turn state follows the current step.** The client host carries the
permission policy, the steering hook, the async handler, and the event sink, and
the runtime rebinds it before every turn. A session shared by several steps
answers each step with *that step's* configuration and streams its output to
*that step's* event bridge — not the ones belonging to whichever step happened
to open the connection. The host is held by reference the whole way down; the
protocol client reads it at call time rather than snapshotting it.

**Connection-level settings must agree.** `clientCapabilities` is negotiated
once during `initialize`, and one connection speaks to one agent, so a step that
joins an existing session cannot change either. Doing so is a configuration
error (`ACP_SESSION_CAPABILITY_CONFLICT`, `ACP_SESSION_AGENT_CONFLICT`) rather
than a silently ignored request.

### Output → harness events

Every `session/update` notification is mapped onto the harness's observable
event surface, so a coding agent's output streams exactly like a `callModel`
step's. The `AcpEventBridge` translates each variant into the same
`source: 'sdk'` broadcaster events the model-call path emits:

| SessionUpdate | Mapped `sdk` events |
|---|---|
| `agent_message_chunk` | `response.output_item.added` (message, once) + `response.output_text.delta` |
| `agent_message_chunk` with an image | `response.output_item.added`/`.done` of an `image_generation_call` item whose `result` is the image as a data URL — as a model's generated image; never text |
| `agent_thought_chunk` | `response.reasoning.delta` |
| `tool_call` | `response.output_item.added` (function_call) + `response.function_call_arguments.delta`/`.done` + `response.output_item.done` |
| `tool_call` of the agent's own tool | also the framework `tool_call_started` `{ name, callId, title, kind?, locations?, status? }`, as the `callModel` tool loop emits it; `status` when the agent said `pending` or `in_progress` |
| `tool_call` / `tool_call_update` of a call still running | the framework `tool_progress` `{ name, callId, … }` with what the update changed: `status`, `title`, `kind`, `locations`, `progress`, `content`, and `input` — the call's `rawInput`, whole, when it differs from what the call had. An update that finishes the call with new input reports that `input`, with the update's other changes but not its content, just before its completion, which carries none. The same input with its keys in another order, or a null `rawInput`, is no change |
| `tool_call` / `tool_call_update` that reports the call `completed` or `failed` | the framework `tool_call_completed` `{ name, callId, error, output?, content?, result? }`, once per call; `content` is the call's latest content as structure, `output` the text it carries, `result` its raw output |
| `plan`, draft `plan_update` | the framework `plan_updated` `{ stepId, plan }`: entries, or a markdown or file plan, with its `id` |
| draft `plan_removed` | the framework `plan_removed` `{ stepId, id }` |
| `current_mode_update` to another mode | the framework `agent_config_updated` `{ stepId, mode }` |
| `config_option_update` that changes the `model` option or the effort option (category `thought_level`, else id `effort` or `reasoning_effort`) | the framework `agent_config_updated` `{ stepId, model?, effort? }` with what changed; `effort: null` when the options no longer have one |
| the turn starting | the framework `agent_config_updated` `{ stepId, mode?, model?, effort? }`: the session's current mode, model and effort, when it has any |
| every other variant — `user_message_chunk`, `available_commands_update`, `session_info_update`, `usage_update`, … | nothing: session state the runtime tracks on the live session, not output |

**What a call's events carry.** The fields are the harness's own (`08-runtime`
§ Tool calls, plans and agent settings), read from the agent's update. Which
tool a call is to, `toolId` and `toolServer`, is the agent's own business, so
its adapter reads it: `AcpAgent.toolIdOf(update)` (`defineAcpAgent({ toolIdOf
})`). `claudeCode()` reads `_meta.claudeCode.toolName` — `Read`, or an MCP
tool's `mcp__<server>__<tool>` as `toolId: <tool>`, `toolServer: <server>`;
`codex()` reads an MCP call's `rawInput` `{ server, tool }` (or its
`mcp.<server>.<tool>` title). A call the adapter cannot place, or one whose
reader throws, goes by its `kind` — so the calls an agent names by title alone
("Run ls", "Run pwd") group as one tool — and, with no kind but `other`, by
its title. A step tool's call the bridge runs is
identified by the tool's own `name`. `title`
and `kind` as given, `locations` as `{ path, line? }`, `progress` from the
update's `_meta.progress` or its raw output's `progress` (a value above 1 is a
percentage), and `content` mapped entry by entry — a `diff` keeps `path`,
`oldText` (null for a new file) and `newText`; a `terminal` its `terminalId`;
text becomes `input_text`, an image `input_image` and audio `input_file`,
each as a data URL, and a `resource_link` or `resource` the entry of the same
name. An update that leaves `content` out keeps
the call's content as it was, so a final update that only says `completed`
still completes the call with everything it produced. A final update that also
renames or relocates the call reports that as a `tool_progress` first. An
update that changes nothing emits nothing. A step tool's call an agent makes
through the tool bridge presents as the tool declares (`02-step-variants`
§ Presentation), exactly as in a `callModel` step; a call announced to one that
never reached it presents as the agent announced it.

As a result `getTextStream()`, `getReasoningStream()`, `getItemStream()`, and
`getFullStream()` all surface ACP output, and a host sees exactly the events a
`callModel` step emits: nothing on the stream names the protocol, and event
data names the step, never the adapter. Each call item ends
(`response.output_item.done`) carrying the whole call — its name and
arguments — before its `tool_call_started`. Every call that starts also
completes before the turn's `response.completed`: one the agent never reported
finished when its turn ends — normally, cancelled, or failed — completes
failed, and a call the agent reported only in its turn result gets its whole
lifecycle then, with the output the result recorded.

**One record per call.** The turn keeps one record for each of its tool calls,
shared by the step's agent and its nested agents, keyed by the id its item and
its lifecycle carry. The agent reports its own tools' calls. A call to one of
the step's own Noetic tools is reported once, by the tool bridge, when it runs
it (spec 38): its item, carrying the arguments it runs with, then
`tool_call_started`, under the id the bridge runs it under — never from the
agent's `tool_call`, which only announces it. An announcement under that same
id is the same call, whenever it arrives. At the turn's end the
announcements the bridge never ran under their ids are paired with the calls
it ran under ids no announcement had: first the same tool with the same
input — the same call, which shows nothing more; then by tool alone. When no
run of a tool is left over, its remaining announcements never reached the
tool, and each completes failed on its announcing agent's stream; when some
are left but fewer than the announcements, which ones ran is unknown, so none
is reported failed on a guess. A call id announced twice is one call. A call
started and never completed — one whose pipeline threw — completes failed
before its stream's `response.completed`, and a call the agent reported only
in its turn result completes as that result recorded it (no result: failed).

Message and call items end as a model's stream ends them:
`response.output_text.done` carries the message's text and
`response.output_item.done` the whole message or call. The turn's outcome
reaches the host on `turn_completed` as `stopReason` (spec 08), whatever the
step's `emit` filter drops.

The client accepts every `session/update` variant of the current protocol, so
normal traffic from current bridges never draws a `-32602 Invalid params`
answer. A variant newer than the protocol library is taken off the stream
before the library sees it and handed to the runtime as it is, rather than
being rejected; it emits nothing. The turn accumulator ignores variants with
no transcript content, except the draft plan updates: a `plan_update` with
`items` replaces the plan snapshot and `plan_removed` clears it.

**Turn metadata.** The turn a step accepts records on `ctx.lastStepMeta` the
same fields a `callModel` step does, once its outcome is settled (after its
`afterModelCall` layers), so a refused, cancelled or retried turn publishes
none; every attempt's spend is charged all the same:

- `stopReason` — `end_turn`, `max_tokens` or `max_turn_requests`. A token or
  turn cap returns normally; this is how a caller tells a truncated turn from
  a complete one. A refusal or a cancellation is an error, not metadata.
- `usage` — the turn's tokens as `RoundUsage`, when the adapter supplies them
  (`AcpTurnResult.usage`), charged to the run's token and cost totals like a
  model call's. The protocol specifies the `usage` a `session/prompt` answer
  reports as the session's running total, so the runtime charges nothing from
  it on its own; an adapter whose bridge reports each turn's own figures reads
  them with `usageOf` (`defineAcpAgent`), as a `RoundUsage`. `claudeCode()`
  and `codex()` do, with `turnUsage`: claude-agent-acp 0.93 and codex-acp
  2.2.2 each tally the turn alone, and both leave cache reads and writes out
  of `inputTokens`, so the turn's input is all three, with `cachedTokens` and
  `cacheWriteTokens` as the bridge reports them. A preset's `usageOf` option
  replaces its reader, or with `false` charges no turn — for a bridge that
  reports the session's running total.
- `model` — the model the turn ran with: the current value of the session's
  `model` config option (found by category, else by id, as the session finds
  it to set it), else the model the step selected.

`usage_update` (`{ used, size }`) is the session's context-window occupancy,
not billed tokens, and never becomes usage or cost. The turn's
`response.completed` carries only its `stopReason`. A turn whose signal is
already aborted when it would start is never sent to the agent: it ends
`cancelled` at once.

**Replay is not output.** While `session/load` runs — for an explicit
`session.load` or for the resume of an earlier attempt's session — every update
the agent sends is its loaded history. None of it reaches the event stream or
the turn's items. Normal forwarding resumes before mode
and model selection and the prompt, so even a follow-up that then fails
selecting its mode shows none of the old answer as new output.

**A turn always closes its bracket.** The bridge opens every turn with
`response.created` and closes it with `response.completed` — carrying the stop
reason on success, and an `error` reason when the turn throws. An agent that
streams nothing still emits a lifecycle, and the text and tool-call events are
synthesized from the result when the stream carried none. This matters most on
the failure path: a consumer driving a UI off `getFullStream()` would otherwise
wait forever on a response that never completes. `emit: false` suppresses all
of it.

Items follow the same rule: assistant text becomes a `MessageItem`, a `tool_call`
becomes a `FunctionCallItem`, and a completed `tool_call_update` becomes a
`FunctionCallOutputItem` whose output renders the ACP content structurally —
diffs and terminal references included, never dropped. Items keep the order the
agent produced them in: each run of text between tool calls is its own
`MessageItem`, so a turn reads message, call, result, message, as a `callModel`
round does.

## Driving an agent from a model, and from a human

A step puts the agent where the *author* decided it goes. Two other surfaces
put it where the *model* or the *user* decides.

### As a tool the model can call

`acpAgentTool()` wraps an agent as a `Tool`, so a `callModel` step can delegate
by calling it:

```ts
import { acpAgentTool, callModel } from '@noetic-tools/core';
import { claudeCode } from '@noetic-tools/acp';

callModel({
  id: 'plan',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'Plan the work. Delegate implementation to the coding agent.',
  tools: [
    acpAgentTool({
      agent: claudeCode(),
      permissions: { allow: [{ kind: 'read' }, { kind: 'edit' }] },
      // A reuse key lets the model hold a conversation with the agent across
      // several calls instead of starting cold each time.
      session: { reuse: 'delegate', keepAlive: 'run' },
    }),
  ],
});
```

The tool takes `{ prompt }` and returns `{ text }`. Underneath it runs the same
`step.acpAgent` through `harness.run` on the calling tool's context, so the
delegated turn lands in the same item log, usage totals, and event stream as any
other step — it is a real step, not a side channel. The default name is
`delegate_to_<agentId>`.

### Permission requests routed to a person

A declarative policy can only answer what it was told in advance. When the
decision belongs to a human, `askUserForPermission()` publishes the request on
an external channel and parks until an answer comes back:

```ts
import { askUserForPermission } from '@noetic-tools/acp';

step.acpAgent({
  id: 'review',
  agent: claudeCode(),
  prompt: 'Fix the failing test',
  permissions: { default: 'deny' },          // policy abstains …
  onPermissionRequest: askUserForPermission(), // … so the human decides
});
```

The integration subscribes once per harness and answers:

```ts
const decisions = harness.getChannelHandle(acpPermissionDecisions, ACP_PERMISSION_SCOPE);
for await (const prompt of harness.getChannelStream(acpPermissionRequests, ACP_PERMISSION_SCOPE)) {
  const optionId = await showApprovalCard(prompt);  // prompt.options are the agent's own
  resolveAcpPermission(decisions, { requestId: prompt.requestId, decision: 'allow', optionId });
}
```

Requests use a queue (each belongs to exactly one reviewer) and decisions a
topic (broadcast, each waiter filters for its `requestId`) — the shape
`@noetic-tools/chat-sdk` already uses for tool approvals. The handler parks on
the decision topic *before* publishing its request, because topic delivery
reaches only subscribers parked at send time; publishing first would let a fast
reviewer answer into the void. A prompt waits until it is answered or the turn is cancelled: a permission
request never times out unless `timeout` is set. When a set timeout passes the
prompt is denied (or takes `onTimeout`): waiting must not become approval.

Because reaching a person means reaching a channel, `onPermissionRequest`
receives `(request, ctx, info)` — the executing context, plus which agent and
step are asking.

### Interrupting and releasing live agents

A host never handles an agent's connection. A running turn is interrupted like
any other, with `harness.abort()` (the step's agent is sent `session/cancel`
and the step ends `cancelled`), and `harness.close()` releases every
connection the harness still holds, whatever its keep-alive scope. Follow-up
prompts go through a step with the same `session.reuse` key, so every turn
lands in the item log, usage accounting, and event stream.

## JSON workflow nodes

One node kind, with the agent named by a registry key:

```json
{
  "kind": "acp-agent",
  "id": "review",
  "agent": "claude-code",
  "prompt": "Review the diff",
  "instructions": "Never push to main.",
  "mode": "plan",
  "permissions": { "default": "deny", "allow": [{ "kind": "read" }] }
}
```

`instructions` is a string (§ Instructions); a document cannot set the
adapter's `sessionMeta`. The hydrator resolves `agent` from `HydrationContext.acpAgents`, an **open**
registry: supporting a new agent needs another entry, not a schema change. An
unregistered reference fails hydration with `UNKNOWN_ACP_AGENT_REFERENCE`. The
published JSON Schema is regenerated from the Zod source (`bun run gen:schema`).

A node's `tools` take what a `callModel` node's take — `{ "type" }`,
`{ "connection", "ops"? }` and inline `{ "mcp": … }` entries in ACP's
`McpServer` shape — hydrated to the step's `tools` and served through the
bridge like a TypeScript step's (`26-json-workflow-runtime` § Tools). Each
`{ "mcp" }` server is checked against the host's `mcp` allowlist — HTTP/SSE by
URL pattern, stdio by exact command and args and started through the node's
agent's `spawn`, header and environment values only as bound
`{ "$secret": "<name>" }`s, policy from the grant. Anything the allowlist does
not grant is refused with `CONNECTION_NOT_ALLOWED` before the agent starts
(`26-json-workflow-runtime` § MCP servers).

Because a node decides what the agent can reach on the host — `terminal`
alone hands it a shell — `parseAndRunWorkflow` and `dynamicWorkflow` also hold
a document they run to the host's `acp` allowlist: the most a node may ask of
each agent in `permissions`, `mode`, `model`, `cwd`, `clientCapabilities` and
`session` (narrowest by default: deny-only permissions, no `mode`, any
`model`, the harness's cwd, `readTextFile` only, `keepAlive` up to `run`, no
`load`). Anything more is `CONNECTION_NOT_ALLOWED` before the agent starts. A
document's `session.reuse` keys live in a namespace of their own per run, so
its nodes never join a session the host opened
(`26-json-workflow-runtime` § What a document may ask of an agent).

## Core decoupling invariant

`@noetic-tools/core` imports only the *contract types* from
`@noetic-tools/types` and resolves *agent instances* from the step
(`step.agent`) or the hydration registry. It never imports `@noetic-tools/acp`,
so **no protocol code is loaded at runtime by core** — the emitted
`packages/types/dist` has no `import`/`require` of the protocol package, only
type-only re-exports that erase at compile time. Enforced by
`.sentrux/rules.toml` (`core → acp` forbidden, and the reverse).

The npm dependency tree is a separate question, and the honest answer is
different: `@noetic-tools/types` declares the protocol package as a real
`dependency` so its `.d.ts` re-exports resolve for consumers, which means
installing core installs it (it takes zod as a peer, so the workspace's zod
serves it). Runtime import graph clean; install graph not.

## Future Considerations

- **MCP over ACP.** The ACP RFD `mcp-over-acp` (draft, request-scoped since
  2026-09) offers an `{ "type": "acp", "name", "serverId" }` MCP server whose
  messages travel as `mcp/message` requests on the ACP connection itself
  (`mcpCapabilities.acp`), which would need no `reach` at all. It needs MCP
  2026-07-28, the client on the SDK's `unstable` entry (which implements it;
  the stable 1.x entry rejects an `acp` server), and an agent that advertises
  it — none of
  Claude Code, Codex (`acp: false`), Gemini CLI, opencode or pi-acp does yet.
- Protocol features still in draft upstream (`session/resume`, `session/list`)
  arrive with a version bump of `@agentclientprotocol/sdk`.
  Its 2.x line drops `ClientSideConnection` for a builder API
  (`client({ name }).connectWith(...)`), so moving to it is a rewrite of the
  connection driver, not a version bump.
- Feeding ACP `plan` updates into the plan context layer, so a sub-agent's plan
  becomes part of the host agent's visible state.
