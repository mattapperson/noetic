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
acp ──────────→ types          (core never imports acp)
core ─────────→ types          (resolves agents via contract + registry)
platform-node ─→ acp, core     (the local adapter opens its links with acp's keeper)
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
  `.` entry point is runtime-neutral; the Node stdio transport, the keeper and
  the function that opens a local link (`openLocalLink`) live behind the
  `./stdio` subpath, and the runner's server behind `./remote`, so a browser
  bundle never pulls in `node:child_process`. It exports no subprocess
  adapter: those live in core and the platform packages (§ The subprocess
  adapter).
- **`@noetic-tools/core`** — besides the step, the adapters that need no
  platform: `createRunnerSubprocessAdapter` (the host's end of a remote
  runner, over any frame link), `createLinkSubprocessAdapter` (an adapter
  from `open` alone) and the in-memory adapter, which takes an `open`. The
  runner's frames (`HostFrame`, `RunnerFrame`, `FrameLink`) are a contract in
  `@noetic-tools/types`, which the runner's server in `@noetic-tools/acp` and
  its client in core both read.

## The contract

Three levels, mirroring the protocol: an agent opens a connection, a connection
carries sessions, a session runs turns.

```ts
interface AcpAgent {
  readonly specificationVersion: 'acp-v1';
  /** Free-form, e.g. 'claude-code'. An OPEN set — no enum. */
  readonly agentId: string;
  /** The harness subprocess adapter the agent names, when it names one. */
  readonly subprocess?: string;
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
one), `whenHostExits` (`'keep'`, the default, or `'stop'`) and `subprocess`
(the harness's subprocess adapters and the one the step names, § The
subprocess adapter); a
`SubprocessLink` may offer `attach(handle)`, and an `AcpTransport` its
`reattach` handle.

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

`ShellAdapter` cannot carry it: a shell command runs once and returns. A
`SubprocessAdapter` can, through `open` (§ The subprocess adapter).

An agent is reached one of two ways:

- **A command, run through a subprocess adapter** — how every preset runs.
  The adapter's `open` hands back a `SubprocessLink`, once per connection,
  before the agent starts:

  ```ts
  interface SubprocessLink {
    reach(bridge: ToolBridgeAddress): Promise<ToolBridgeAddress>;
    launch(command: SpawnCommand): Promise<AcpTransport>;
    spawn: Spawn; // (command: SpawnCommand) => Promise<ByteStream>
    attach?(handle: AcpReattachHandle): Promise<AcpTransport>;
    close(): Promise<void>;
  }
  ```

  `reach` carries the tool bridge (spec 38) to where the agent can use it,
  `launch` starts the agent with launch settings built from that address, and
  `spawn` starts a process beside it — a stdio MCP server that must run there
  — whose stdio comes back, so Noetic stays its client. `open` is not the
  agent's alone: any caller may start a process through a link and hold its
  stdio, and an adapter runs a `process` request the same way (`08-runtime`
  § SubprocessAdapter). A command agent's
  `AcpAgent.spawn` is `spawnOn(adapter)`; `Spawn`, `SpawnCommand` and
  `ByteStream` live in `@noetic-tools/types`, so `@noetic-tools/mcp` takes the
  same seam (`mcp({ command, spawn })`) without importing this package. Closing
  the agent's stream closes the link.
- **A transport** — `AcpTransportFactory`, for an agent someone else started.
  It cannot carry the bridge or apply launch settings, so a step that gives it
  `tools` fails (`AcpAgent.refusesTools`):
  `ACP_TRANSPORT_CANNOT_LAUNCH` when the agent's wiring has launch settings,
  `ACP_TRANSPORT_CANNOT_REACH` otherwise. With `tools` left out it gets none.
  `gemini()` without `trustWorkspace: true` refuses tools the same way, with
  `ACP_AGENT_CANNOT_TAKE_TOOLS`: Gemini starts no MCP server in a folder it
  does not trust (`38-acp-tools` § Gemini CLI and folder trust).

### The subprocess adapter

The subprocess adapter is the one place processes run: a harness's step
children, commands run to completion, and — through `open` — processes whose
stdio the caller holds, an ACP agent and a stdio MCP server beside it. Where
they run is the harness's to say, like its storage and its filesystem.

```ts
interface SubprocessAdapter {
  // spawn, get, stop, pause, resume, isAlive, reattach, listLive (spec 08)
  open?: SubprocessOpen; // (options: SubprocessOpenOptions) => Promise<SubprocessLink>
}

interface SubprocessOpenOptions {
  signal?: AbortSignal;
  whenHostExits?: AcpWhenHostExits;
}
```

An agent needs an adapter with `open`. The default harness adapter (in
memory) has none, so a harness that runs a command agent names one:

```ts
import { createLocalSubprocessAdapter } from '@noetic-tools/platform-node';

new AgentHarness({
  environment: {
    subprocess: createLocalSubprocessAdapter(),
  },
});
```

A harness may name several subprocess adapters, one of them the default
(`08-runtime` § Named Adapters). A step and an agent preset pick one by name:

```ts
new AgentHarness({
  environment: {
    subprocess: {
      laptop: { adapter: createLocalSubprocessAdapter(), default: true },
      builder: { adapter: createWebSocketSubprocessAdapter({ url, token }), displayName: 'Build host' },
    },
    fs: {
      laptop: { adapter: createLocalFsAdapter(), default: true },
      builder: { adapter: hostFs },
    },
  },
});

step.acpAgent({ agent: claudeCode(), prompt });                        // the defaults
step.acpAgent({ agent: claudeCode(), prompt, subprocess: 'builder', fs: 'builder' });
claudeCode({ subprocess: 'builder' });                                 // a preset names one
```

A command agent runs through the first of these:

1. the harness adapter the step names (`step.acpAgent({ subprocess: 'builder' })`);
2. the harness adapter the agent names (`claudeCode({ subprocess: 'builder' })`);
3. the harness's default subprocess adapter.

A step, a preset, `customAcpAgent` and `defineAcpAgent` take a name only,
never an adapter. Adapters are given once, on the harness's
`environment.subprocess`, so the name a step resolves to always says which
adapter its agent runs through — the name a session record stores
(§ Resuming a step).

A name the harness lacks fails the step with `ADAPTER_UNKNOWN`, before the
agent starts; the message lists the names the harness has. The adapter the
order lands on is used as it is, and nothing stands in for it: one with no
`open` — the in-memory default of a harness given no `environment.subprocess`
— fails to connect with `SUBPROCESS_CANNOT_OPEN`, whose hint is to give the
harness `environment.subprocess: createLocalSubprocessAdapter()` from
`@noetic-tools/platform-node`, or to name another adapter. An agent that
names no adapter and is connected by hand with no `SubprocessChoice` fails
the same way.

The core passes `AcpAgent.connect` a `SubprocessChoice` as
`AcpConnectOptions.subprocess`, on a first connection and on a reattach alike:

```ts
interface SubprocessChoice {
  /** The harness's `environment.subprocess`. */
  readonly adapters: AdapterSet<SubprocessAdapter>;
  /** The adapter a step names. It comes before the one the process's owner names. */
  readonly name?: string;
}
```

The agent resolves the order above against it, so a host names its adapters
once, not on every agent. An agent that names an adapter says so as
`AcpAgent.subprocess`, which is how the core knows where the step's agent runs
(§ Session reuse and lifetime, § Resuming a step). An agent that names an
adapter and is connected with no `SubprocessChoice` — by hand, outside a step
— fails with `SUBPROCESS_NAME_WITHOUT_HARNESS`.

**The agent's filesystem and shell.** The client host that serves the agent's
`fs/*` and `terminal/*` calls (§ Client-side capabilities) takes the harness's
default `fs` and `shell`, or the ones the step names with `fs` and `shell`.
The three names are independent: a step may run its agent on the build host
and serve it files from there with `subprocess: 'builder', fs: 'builder',
shell: 'builder'`, or name only one.

A process started beside the agent follows it. A `Spawn` takes
`{ subprocess }`, the same `SubprocessChoice`, as its second argument, and
`agent.spawn` starts the process through the adapter the order above gives. A
connection provider is given the harness's adapters as
`ConnectOptions.subprocess`, and `mcp()` hands it to its server's `spawn`, so
`mcp({ command, spawn: agent.spawn })` and a JSON `acp-agent` node's stdio
`{ "mcp" }` entries start where the agent runs. A step that names a
`subprocess` carries that name to the stdio servers its `tools` list, on both
paths: the turn connects each entry with the step's name in its
`ConnectOptions.subprocess`. `mcp()` passes that on to `spawn`; a JSON node's
entries get a `spawn` already bound to it, so a host's own `mcp.provider`
that forwards nothing still starts the server beside the agent
(`26-json-workflow-runtime` § MCP servers). An entry two steps list connects
once, so both must resolve it to the same place: a second step that lists it
under another `subprocess` name fails the turn with `CONNECTION_NAME_TAKEN`
before anything runs. A stdio `mcp()` server given no `spawn` is a local
subprocess.

**One link per connection.** A connection opens one `SubprocessLink` and
closes it once, however connecting ends: a failed `reach`, `launch`,
`initialize` or `attach` closes it, and so does closing the connection. A
host that lets go of an agent (`AcpAgentConnection.detach`) detaches its
stream once and then closes the link, which stops only what the link still
holds: never the agent it let go of.

`@noetic-tools/acp` exports no subprocess adapter. The adapters live in core
and the platform packages; `@noetic-tools/acp` exports what they open links
with (`openLocalLink`, `loopbackLink`) and the runner's server.

| Subprocess adapter | Package | `step` | `process` | `open` |
|---|---|---|---|---|
| `createLocalSubprocessAdapter({ keeper?, detachedTimeoutMs?, wrap?, onStderr?, onLaunch?, agentId?, … })` | `@noetic-tools/platform-node` | yes | yes | yes — this machine. `launch` starts the agent through its keeper (§ A local agent outlives its host), `reach` serves the bridge on the keeper's own loopback port, `attach` reaches a kept agent again; `spawn` starts a child process. `keeper: false` (or no keeper script on disk, as in a single-file bundle) starts the agent as a child process and `reach` returns the bridge's own address. |
| `createWebSocketSubprocessAdapter({ url, token, ca? })` | `@noetic-tools/platform-node` | refused | without `stdin` | yes — a remote runner over WebSocket. Every upgrade carries the runner's bearer token; `ws://` is refused except to a loopback host, so a hop off the host is TLS. |
| `createCommandSubprocessAdapter({ command, args, env? })` | `@noetic-tools/platform-node` | refused | without `stdin` | yes — a remote runner started by a local command and spoken to over its stdio: `ssh host npx -y @noetic-tools/acp serve --stdio`, `docker exec -i ctr noetic-acp serve --stdio`. The command's own channel carries everything. |
| `createSocketSubprocessAdapter(accepted)` | `@noetic-tools/platform-cloudflare-worker` | refused | without `stdin` | yes — a runner at the far end of a WebSocket a Durable Object accepted (the runner's host dialled in). `accepted` returns one accepted socket per link. |
| `createFetchSubprocessAdapter({ url, token, fetch? })` | `@noetic-tools/platform-cloudflare-worker` | refused | without `stdin` | yes — a runner a Worker dials: a `fetch` upgrade carrying the bearer token, TLS off the loopback interface. |
| `createRunnerSubprocessAdapter(dial)` | `@noetic-tools/core` | refused | without `stdin` | yes — a remote runner over any `FrameLink`; the four above are this over a link they open. |
| `createLinkSubprocessAdapter(open)` | `@noetic-tools/core` | refused | yes | yes — the `open` it is given. |
| `createInMemorySubprocessAdapter({ open? })` | `@noetic-tools/core` | in this process | its `run` hook | only when given one: `loopbackLink(toAgent)` from `@noetic-tools/acp` stands an in-process agent up over the real wire protocol, with no process — the way to test an ACP-backed step. |

An adapter built from `open` alone has no Noetic runtime where its processes
run, so its `spawn` refuses a `step` request with `SUBPROCESS_RUNS_NO_STEPS`.
It runs a `process` request through a link of its own (`08-runtime`
§ SubprocessAdapter). The runner's frames carry no end of input, so a runner
adapter refuses a `process` request that has `stdin` with
`SUBPROCESS_CANNOT_END_INPUT` rather than leave the command waiting for one.
A harness that runs steps in one place and agents in another names both
adapters and picks by name.

| Transport | Use |
|---|---|
| `loopbackTransport(toAgent)` | An in-process agent an `AcpTransportFactory` attaches to. |
| `stdioAcpTransport` (`@noetic-tools/acp/stdio`) | An attached child process. |
| custom transport | Anything yielding a duplex byte stream to an agent already running. |

**A local agent's process tree.** Agents are usually started through a wrapper
— `npx`, or a Node launcher that runs a native binary as its child — so the
process Noetic spawns is rarely the agent itself. The keeper, and
`stdioAcpTransport` and a local adapter without one, start every process as the leader of its own process group
(POSIX) and, when the transport closes or its signal aborts, stop the whole
group: end its stdin, `SIGTERM`, a two-second grace period, then `SIGKILL`; on
Windows, `taskkill /T /F` on its tree, even when the immediate child already
exited, so its descendants still stop. A leader that exited but is not yet
reaped makes its group refuse signals (EPERM on macOS); shutdown then waits for
it to be reaped rather than failing. A child that is not a group leader is
signalled itself. Closing a local adapter's link stops everything it started in
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
binary it ships — keeps the adapter and changes the command:
`createLocalSubprocessAdapter({ wrap })`. `wrap(command, { bridges, agentEnv })` runs just before
the agent starts. It receives the command the preset built, with `env` already
the complete environment the agent would get (this process's, plus the
preset's and the tool wiring's), `agentEnv` — the preset's and the wiring's
variables alone, for a wrapper that builds the agent's environment itself —
and the bridge addresses `reach` handed out,
so a sandbox can let exactly those loopback ports through. The command it
returns runs with exactly its own `args`, `env` and `cwd` — nothing is merged
back in — as the leader of its own process group, through the keeper or not,
with the shutdown above. `onStderr` receives the agent's stderr, which
otherwise goes to the host's. `onLaunch` is told of each agent the adapter
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

**The keeper.** `createLocalSubprocessAdapter()` starts each agent through a keeper: a small
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
this host's handlers, and then the turn's result, as soon as the agent answers. The keeper keeps the answer after
delivery, so another host can collect it if the first one died before saving
the step. The next prompt replaces that answer. With no prompt to collect,
it resolves `undefined`. A keeper that is gone, or an agent with no such session,
rejects with `AcpConnectError`.

**A durable run** stores the handle with the step's session record
(§ Resuming a step), so a resumed step reattaches before it tries anything
else.

**`killAgentsOnExit`** on the harness asks every agent it starts for
`whenHostExits: 'stop'`: a kept agent stops when its host's connection drops,
and an agent started directly (a `transport`, or a local adapter without a
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

`noetic-acp serve` (the `@noetic-tools/acp` bin, Node) runs where the agent
should run and serves one host per channel — a WebSocket, or its own stdio with
`--stdio`. When the channel closes, the MCP servers it started stop; the agent
is kept (§ A runner keeps its agents). Over that one
channel, as JSON frames (`HostFrame` / `RunnerFrame`, whose schemas live in
`@noetic-tools/types`; the host's end is core's
`createRunnerSubprocessAdapter`):

- `keep` (first, from a host that keeps agents) says agents launched over this
  channel run through a keeper, and what `whenHostExits` asks;
- `start` runs a process (the agent, or an MCP server beside it) and carries
  its stdin, stdout and exit — but no end of its stdin; a kept agent's `started` carries its reattach
  handle;
- `attach` carries the stream of an agent an earlier channel launched, from
  that handle;
- `reach` opens a port on the runner's loopback interface; each HTTP request
  the agent sends there travels to the host, which answers it from its own
  bridge only — a request for any other path is `404`, and the host forwards
  the parsed path to the bridge's own origin, never the raw one. The bridge
  still checks the bearer token, `Host`, and `Origin` itself.

So the agent needs no route back to the host, and the one channel is the only
network hop. This one design covers ssh (`createCommandSubprocessAdapter` over `ssh`),
containers (`docker exec -i`) and WebSocket, in place of an ssh reverse
forward or a container host-gateway address.

#### A runner keeps its agents

A runner keeps the agents a host launches through it exactly as
the local adapter does (§ A local agent outlives its host): after a `keep`
frame, it launches each agent through a keeper beside the runner, and serves
the bridge to it on the keeper's port, which forwards to the channel's port
while a channel is open. When the channel drops — the host died, the network
went, an ssh session ended — the runner lets the keeper go without stopping it,
so the agent keeps working under the keeper's `whenHostExits`, and holds what
it sends. A `--stdio` runner exits with its channel; the keeper, in its own
session, does not.

A later host reconnects with the link's `attach(handle)`: over a new channel —
to the same WebSocket runner, or through a new `--stdio` runner on the same
host and user — an `attach` frame makes the runner connect to that keeper
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
that names none; a working directory missing where the runner runs is an
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
`spawnOn(adapter)` opens a link per process, for a stdio MCP server that
must run where the agent runs. Such a server starts as the MCP SDK starts a
local one: with `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER` from the
environment there, plus its own `env`, never the rest of that environment
(the local adapter and the runner alike). Only the agent `launch` starts gets
the whole environment.

## Client-side capabilities

`@noetic-tools/acp` implements the ACP `Client` interface against an
`AcpClientHost` the runtime builds from `Context`. Its `fs` and `shell` are
the harness adapters the step names (`fs`, `shell`), else the defaults
`ctx.fs` and `ctx.shell` (§ The subprocess adapter):

| ACP client method | Backing |
|---|---|
| `fs/read_text_file` | `fs.readFileText`, with the spec's 1-indexed `line`/`limit` window |
| `fs/write_text_file` | `fs.writeFile`, parent directories via `fs.mkdir` |
| `terminal/create`·`output`·`wait_for_exit`·`kill`·`release` | A terminal registry over `shell.exec`: `onData` feeds an `outputByteLimit` ring buffer, one `AbortController` per terminal backs `kill`, and `ShellExecResult.exitCode` becomes the exit status |
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
  subprocess: 'builder', // optional: harness adapters by name
  fs: 'builder',
  shell: 'builder',
});
```

`subprocess`, `fs` and `shell` each name one of the harness's adapters of that
kind (§ The subprocess adapter). They are plain strings, fixed when the step
is built, and checked against the harness when the step runs.

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
args, env, spawn: agent.spawn })`: `AcpAgent.spawn` — `spawnOn(adapter)` for a
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

**A session is on one set of adapters.** A connection is one agent process,
served by one filesystem and one shell, so the adapters a step resolves to —
its `subprocess` (the step's name, else the agent's, else the default), `fs`
and `shell` — are part of what a `reuse` key names. Steps that share a key and
resolve to the same three share one connection; a step that resolves to a
different one gets a connection of its own under the same key, and steps that
agree with it share that. A step that names the default and a step that names
nothing resolve to the same adapter.

`session.load` resumes an existing ACP session id via `session/load` instead of
creating a new one. The agent replays the loaded conversation as
`session/update` notifications before it answers; see § Output → harness events
for how that replay is told apart from the new turn.

### Resuming a step

On a durable run, the step saves its intent before sending a prompt. The
record names the agent and session, the prompt, the settings fingerprint and
the subprocess adapter. For a session owned by the step, it also keeps the
reattach handle if there is one. A failed intent write stops dispatch.
The record lives at `execution:<root id>:pending:<ledger key>/acp-session`.
The step removes it after its output is in the completion ledger. Until then,
a kept agent can hand a replacement host the prompt's updates and result.

A replacement reaches the same keeper through the stored adapter name,
attaches to the same session and collects the original prompt. A live or
finished prompt is collected by ID without sending another one. The keeper
refuses to accept the same ID twice. Before sending a guidance prompt, the
host saves its ID, guidance and retry count. A replacement can send that
prompt only when the keeper confirms it never received the ID. A legacy
intent without a prompt ID requires a retained result. A changed adapter name fails with
`ACP_SESSION_ADAPTER_CONFLICT`. Changed session settings fail with
`ACP_SESSION_SETTING_CONFLICT` and the host detaches from the agent.

If the transport drops and a handle can recover the prompt, the host detaches
and the leased turn cuts with `acp_link_lost`. Waking the turn tries the same
session after the normal back-off. An agent or session confirmed gone, a step
without a reattach handle, and a reused session whose answer cannot be tied
to this dispatch can all leave `acp_outcome_unknown`. The step refuses to
send another prompt. A transient failure to reach the keeper only retries the attachment.

The tool bridge records completed calls in the step ledger and uses the
agent's original call ID to match a redelivery. If a matching receipt lacks
enough identity to tell a redelivery from a new call, the outcome is unknown
(`38-acp-tools` § Replay). The keeper does not establish whether an agent's own tools, files,
terminal commands or third-party services finished their writes. A host
must establish that outcome before retrying a lost execution that may have
changed external state.

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

`acpAgentTool` takes the step's `subprocess`, `fs` and `shell` names and
passes them to the step it builds (§ The subprocess adapter).

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
  "permissions": { "default": "deny", "allow": [{ "kind": "read" }] },
  "subprocess": "builder",
  "fs": "builder",
  "shell": "builder"
}
```

`subprocess`, `fs` and `shell` are optional names of harness adapters, as on a
TypeScript step (§ The subprocess adapter).

`prompt` may be left out: the node's input is then the prompt, as an empty
`prompt` on `step.acpAgent` makes the step's input the prompt. `emit: false`
keeps the turn's framework events out of the stream, as the step's `emit`
does; the node takes a boolean, not a filter. `parseAndRunWorkflow` and
`dynamicWorkflow` ignore it: a document the host did not write cannot hide its
agent's turn. `output: { "schema": <JSON Schema> }` is the step's `output`: the
agent's final text is JSON-parsed and checked against the schema
(`26-json-workflow-runtime` § Structured output).

A node's `clientCapabilities` take the step's fields, `additionalDirectories`
and `allowAnyPath` included; no `acp` grant widens what an agent reaches on
disk, so a document the host did not write that sets either is refused with
`CONNECTION_NOT_ALLOWED`. A permission rule's `title` is a case-insensitive
substring; `titlePattern`, with optional `titleFlags`, is the source of what
the step writes as a `RegExp` title. A rule takes one or the other.

`content` is the step's `content`: ACP content blocks sent after the prompt.
Every option the step takes as a function — `prompt`, `content`,
`instructions`, `cwd`, `mode`, `model`, `tools`, `onPermissionRequest` and an
`emit` filter — a node reads from a harness param named in `fromParams`
(`26-json-workflow-runtime` § Options from params).

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
each agent in `permissions`, `mode`, `model`, `subprocess`, `fs`, `shell`,
`cwd`, `clientCapabilities` and `session` (narrowest by default: deny-only
permissions, no `mode`, any `model`, no adapter names, the harness's cwd,
`readTextFile` only, `keepAlive` up to `run`, no `load`). Anything more is `CONNECTION_NOT_ALLOWED` before the agent starts. A
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

- **A step's `subprocess` name for its `mcp()` entries.** A TypeScript step's
  stdio `mcp()` entry starts through `agent.spawn` with the harness's
  adapters and no step name, because an entry connects with the turn. Passing
  the name would need the entry to know the step that lists it.
- **`fs` and `shell` on resume.** A resumed step is held to the subprocess
  adapter that started its agent, not to the `fs` and `shell` it named.
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
