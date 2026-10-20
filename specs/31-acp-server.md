# 31 — ACP Server: Serving a Harness as an ACP Agent

> **Depends On:** `27-acp-agent-steps` (protocol library, transports, permission channels, event bridge), `08-agent-harness` (session API — `execute`, streams, seeding, abort), `06-channels` (external channels — the permission park), `11-context-layer-system` (`beforeToolCall` hook)
> **Exports:** `toAcpAgent()`, `serveAcp()` (`@noetic-tools/acp/server`), `clientFsAdapter()`, `clientShellAdapter()`, `AcpServeHarness`, `AcpServeOptions`, `AcpServeSessionInit`, `AcpServePermissionPolicy`; `ToolAcpDeclaration` (`@noetic-tools/types`)

---

Spec 27 puts Noetic on the client side of the [Agent Client
Protocol](https://agentclientprotocol.com/): a Noetic step drives an external
coding agent. This spec is the same protocol pointed the other way — **Noetic is
the Agent** — so any ACP client (Zed, another editor, another Noetic harness)
can drive a Noetic harness as its agent. One harness definition serves chat
platforms through `29-chat-platform-integration`, generative UI through
`28-generative-ui`, and ACP editors through this spec, without changing a line
of the agent itself.

```ts
// my-agent.ts
import { AgentHarness } from '@noetic-tools/core';
import { serveAcp } from '@noetic-tools/acp/server';

const harness = new AgentHarness({
  name: 'my-agent',
  agentGraph: reactLoop,
  tools: [searchDocs, editFile, runTests],
  params: {},
});

await serveAcp(harness).closed;
```

```jsonc
// Zed settings.json
"agent_servers": {
  "My Noetic Agent": { "command": "bun", "args": ["my-agent.ts"] }
}
```

## Two layers

The server splits the same way the client does — a runtime-neutral core and a
Node entry point that owns the process-level transport:

- **`toAcpAgent(harness, options?)`** — exported from the runtime-neutral `.`
  entry. Returns `(conn: AgentSideConnection) => acp.Agent`: the factory shape
  `loopbackTransport()` already accepts. The protocol implementation lives here;
  no `node:*` imports.
- **`serveAcp(harness, options?)`** — exported from `@noetic-tools/acp/server`.
  Binds `toAcpAgent` to the **current process's** stdin/stdout (the inverse of
  `./stdio`, which spawns a child and binds to *its* stdio) and returns
  `{ closed: Promise<void>, close(): Promise<void> }`. The one-liner
  `await serveAcp(harness).closed` runs until the client disconnects; `closed`
  resolves when the peer's stream ends, and `close()` cancels live sessions
  (`harness.abort` per session) before tearing the transport down. The handle
  is a plain object, not a thenable — awaiting the call itself would resolve
  immediately.

Because `toAcpAgent` produces exactly what `loopbackTransport` consumes, three
things fall out with no additional code:

```ts
// 1. A Noetic harness as a sub-agent of another Noetic harness — in-process,
//    over the real wire protocol.
step.acpAgent({
  id: 'research',
  agent: customAcpAgent({
    agentId: 'researcher',
    transport: loopbackTransport(toAcpAgent(researchHarness)),
  }),
  prompt: 'Survey prior art for the change in this diff',
});

// 2. Testing a served agent by driving it with Noetic's own ACP client —
//    no child process, both directions of the codebase exercising each other.

// 3. Any future transport (socket, sandbox bridge, upstream HTTP/WebSocket)
//    plugs into the same factory.
```

The dependency picture does not change: the server lives in
`@noetic-tools/acp`, which depends only on `@noetic-tools/types`. It drives any
harness through **`AcpServeHarness`**, a structural subset of
`AgentHarnessContract` (`execute`, `getFullStream`, `getItemStream`,
`seedSessionHistory`, `abort` — exactly what the server calls, nothing
speculative) — the same pattern `ChatHarness` established in `29`. Core never
imports this package (enforced by `.sentrux/rules.toml`; the end-to-end test
suite drives a real `AgentHarness` through the served surface via a
devDependency, which the boundary deliberately does not cover).

## Initialization and capabilities

The server answers `initialize` with the library's `PROTOCOL_VERSION` (the
wire revision this package pins has no agent `Implementation`/info block — it
arrives with the protocol's second revision; see Future Considerations).
Advertised `AgentCapabilities` are **derived, not configured**:

| Capability | Advertised when |
|---|---|
| `loadSession` | `options.history` is provided |
| `promptCapabilities.image` / `audio` / `embeddedContext` | the corresponding content blocks are convertible into the harness's `Item` model (image and embedded context are; audio is not until the `Item` model carries it) |
| `mcpCapabilities` | never — MCP server passthrough is not implemented; see Future Considerations |

`authMethods` is empty: a served harness runs with the credentials of the
process that launched it. A capability the server did not advertise is answered
with JSON-RPC method-not-found — the mirror of the client-side rule that a
withdrawn capability is refused rather than quietly served.

## Sessions

`session/new` mints a `sessionId` and uses it **verbatim as the harness
`threadId`** — the identity mapping `29` proved sufficient for chat threads.
The server keeps a `Map<sessionId, SessionEntry>`; `session/cancel` targets
`harness.abort({ threadId: sessionId, reason: 'cancelled' })`, and the entries
are dropped when the connection goes away: the served agent's `dispose()`
cancels every live session and stops its pumps, called by `serveAcp`'s stdin
handlers on the stdio path and by `loopbackTransport`'s `close()` (duck-typed
on `dispose`) on the in-process path. A prompt whose resolved input is empty
short-circuits to `end_turn` without executing a turn.

A harness is constructed once and shared by default. Because `cwd` and platform
adapters are constructor-level on `AgentHarness`, per-session isolation is the
factory overload:

```ts
serveAcp((session: AcpServeSessionInit) =>
  new AgentHarness({
    name: 'my-agent',
    agentGraph,
    tools,
    params: {},
    initialCwd: session.cwd,
    environment: { fs: session.client.fs, shell: session.client.shell },
  }),
);
```

`AcpServeSessionInit` carries `{ sessionId, cwd, mcpServers, client }`.
`session.client.fs` and `session.client.shell` are **`FsAdapter` and
`ShellAdapter` implementations backed by the ACP client's own `fs/*` and
`terminal/*` methods** (`clientFsAdapter({ conn, sessionId, capabilities })`,
`clientShellAdapter({ conn, sessionId, capabilities })`), built only from the
capabilities the client advertised. Operations the wire itself cannot express
— binary writes, `stat`, `readdir`, `rm`, `rename`, terminal `stdin` — reject
with `AcpCapabilityError` too; `mkdir` is a deliberate no-op because clients
create parent directories on write and no directory method exists on the
wire. `appendFile` appends from empty only when the read failure genuinely
means "file missing" — any other failure propagates rather than truncating
the file to just the fragment. The shell adapter honors the `ShellAdapter`
contract's failure semantics: a timeout rejects with the
`TIMEOUT_ERROR_PREFIX` message, a signal abort resolves with what was
collected. This is the whole point of ACP's client-side filesystem:
route the harness's file reads through the editor and the agent sees **unsaved
buffer state**, not what happens to be on disk. Because Noetic already routes
every file and shell touch through adapter contracts, the editor-backed
environment is one constructor argument, not a new code path. A method the
client did not advertise makes the corresponding adapter operation reject with
`AcpCapabilityError` — the factory author decides whether to fall back to a
local adapter instead.

With the single-shared-harness form, sessions share the harness's adapters and
`initialCwd`; the per-session `cwd` is recorded on the session entry and used
for prompt-content resolution only. Serving editors that open different
workspaces from one process requires the factory form.

## The prompt turn

`session/prompt` runs the loop `29` established, translated to the wire:

1. **Convert.** The `ContentBlock[]` prompt becomes one user
   `InputMessageItem` — text blocks to `input_text` parts, images to
   `input_image` parts, and resource links / embedded context rendered as
   text through the same `contentBlockText` the client direction uses, so
   nothing the client sent disappears from the transcript.
2. **Attach, then execute.** A `getFullStream({ threadId: sessionId })`
   iterator is bound **before** `execute()` — `turn_started` is emitted
   synchronously inside `execute()` and the session broadcaster discards events
   when a previously-consumed stream has no live consumer.
3. **Execute.** `execute(items, { threadId: sessionId, messageId })`. The
   generated `messageId` claims the turn in `turn_started.messageIds`, exactly
   as in `29`. A prompt arriving while a turn is in flight queues with the
   default `next-turn` delivery; the protocol says clients wait for the
   turn to end, but a client that doesn't gets coalescing rather than
   corruption.
4. **Stream back.** Events are translated into `session/update` notifications
   until the turn boundary, which resolves the `session/prompt` request with a
   `stopReason`.

The translation is the client direction's `AcpEventBridge` table (spec 27,
"Output → harness events") **run backwards**:

| Harness event | `session/update` |
|---|---|
| `response.output_text.delta` | `agent_message_chunk` |
| `response.reasoning.delta` | `agent_thought_chunk` |
| `tool_call_started` (framework, carries `callId`) | `tool_call` — `toolCallId` = `callId`, presentation from the tool's `acp` declaration (below), status `pending` while gated, `in_progress` once running |
| `tool_call_completed` | `tool_call_update` — `completed` with the output as content, or `failed` carrying the error |
| plan-layer state changes | `plan` |
| `acp.*` passthrough events from a nested `step.acpAgent` | re-emitted as `tool_call` / `tool_call_update` under the delegating call (below) |

Notifications the harness has no source for are simply never sent — ACP treats
absence as unsupported.

**Stop reasons** are the inverse of spec 27's table, classified by the typed
`errorKind` the `turn_aborted` event carries (with the session's cancel flag
as fallback for aborts that carry none):

| Turn outcome | `stopReason` |
|---|---|
| `turn_completed` | `end_turn` |
| `turn_aborted` with `errorKind: 'cancelled'` (or after `session/cancel`) | `cancelled` |
| `turn_aborted` with `errorKind: 'model_refused'` | `refusal` |
| `turn_aborted` with `errorKind: 'budget_exceeded'` | `max_tokens` |
| any other turn error | JSON-RPC error on the `session/prompt` request |

The wire's `max_turn_requests` has no core analogue to map from — core has no
turn-request-limit error kind — so it stays unproduced (see Future
Considerations).

**A turn always closes its bracket**, same rule as the client direction: every
accepted prompt eventually resolves or rejects, including when the harness
streams nothing — an editor driving a UI off the request must not wait
forever. Tool calls close their brackets too: calls still open at the turn
boundary are flushed (`completed` on a normal end, `failed` on abort), so a
cancel mid-tool never leaves the editor with a spinner. And a completed
`tool_call_update` carries the tool's output — or its failure text — as
renderable content.

## Presenting tools to the editor

ACP renders tool calls with a `kind` (`read`, `edit`, `execute`, …), a
human-readable `title`, and affected `locations`. Following the
`ToolUiDeclaration` precedent from `28`, the `Tool` type in
`@noetic-tools/types` carries an optional ACP presentation:

```ts
interface ToolAcpDeclaration<I> {
  kind?: AcpToolKind;
  /** A string, or a bivariant args function (`ToolAcpTitleFn`). */
  title?: string | ((args: InferSchemaOutput<I>) => string);
  locations?(args: InferSchemaOutput<I>): string[];
}

const editFile = tool({
  name: 'edit_file',
  // ...
  acp: {
    kind: 'edit',
    title: (args) => `Edit ${args.path}`,
    locations: (args) => [args.path],
  },
});
```

The server reads declarations from `options.tools` — pass the same array the
harness was built with (`serveAcp(harness, { tools })`); the harness contract
does not expose its tool set, and the serve options are where presentation
concerns live. An undeclared or unlisted tool falls back to `kind: 'other'`
and its name as the title, and title/location functions run only when the
call's parsed arguments were captured from the model stream. The declaration
is presentation only — it never gates anything — so one tool definition
renders natively in chat cards (`29`), OpenUI fragments (`28`), and ACP
editors, from the same source of truth.

## Permissions

The client direction answers `session/request_permission`; the server direction
**issues** it. First-party tool calls are gated by a declarative policy, and
the calls the policy marks `ask` are forwarded to the editor's user:

```ts
serveAcp(harness, {
  permissions: {
    default: 'allow',
    rules: [
      { tool: 'run_tests', decision: 'allow' },
      { kind: 'execute', decision: 'ask' },
      { tool: 'deploy', decision: 'deny' },
    ],
  },
});
```

Rules match on tool name or the tool's declared ACP `kind`; the first decisive
match wins, checked in order `deny` → `ask` → `allow` so an explicit refusal
beats a broad grant, and a required ask beats a broad allow. The **default is
`allow`** — deliberately the opposite of the client direction's `deny`. There,
an unattended external agent must not gain approval by omission; here, the
harness author curated every tool on the harness, and the editor user is
supervising work they initiated, not sandboxing a stranger.

The mechanics:

- The server injects a per-session context layer through
  `ExecuteOptions.extraContextLayers` on every prompt turn — **additive**, so
  the harness's own instructions/history/steering layers keep running (the
  `contextLayers` option's override semantics would silently delete them).
  Its `beforeToolCall` hook evaluates the policy: `allow` returns immediately;
  `deny` returns a deny decision, which the tool loop surfaces to the model as
  a tool error (and the server reports as a `failed` `tool_call_update`
  carrying the refusal). A kind-based rule needs `options.tools` to resolve
  kinds; configuring one without tools raises
  `ACP_SERVE_KIND_RULES_WITHOUT_TOOLS` instead of silently matching nothing.
- `ask` parks the hook on a **permission broker** owned by the served agent.
  The broker registers the park *before* forwarding, so an answer racing back
  in the same tick still lands, and it owns the deadline (`askTimeoutMs`,
  default 5 minutes → deny). A layer hook receives an `ExecutionContext`,
  which has no channel access — this is why the park is a broker, not the
  spec-27 channel pair, which needs a full `Context` to `recv` on.
- The gate **fails closed**: the layer sets
  `onBeforeToolCallError: 'deny'` (a `ContextLayer` contract field this spec
  adds), so a hook that throws or blows the lifecycle's backstop timeout
  denies the call. The default lifecycle behavior — a failed hook abstains —
  is right for observational layers and exactly wrong for a gate, where
  abstention with no other decisive layer collapses into silent approval.
- The broker's forwarder is `session/request_permission` over the wire —
  `toolCall` carrying the pending call's `toolCallId`, title, kind, and
  `rawInput`, with `allow_once` / `reject_once` options — unless the host
  supplied `options.onPermissionRequest`, the in-process hatch for an
  embedding host that owns its own approval surface. The client's answer (or
  the host's) resolves the park.
- While gated, the streamed `tool_call` holds status `pending` (the presenter
  knows the policy will ask); a grant sends the `in_progress`
  `tool_call_update` — from the broker wrapper, so it fires whether the wire
  client or an in-process `onPermissionRequest` answered — and a rejection
  resolves the gate as a deny.
- `session/cancel` during a park is handled by the broker: the serve loop
  calls `cancelSession(sessionId)`, every park for that session resolves as
  `cancel` → deny, the gate unwinds, and the turn resolves with
  `stopReason: 'cancelled'`. Per the protocol, the client answers the
  outstanding `session/request_permission` with a `cancelled` outcome itself.

### The gate contract in core

The permission layer leans on guarantees `@noetic-tools/core` makes about the
`beforeToolCall` gate. They are part of this design, stated here because the
server is their first consumer that needs all three at once:

1. **The gate is async and awaited.** Every tool-executing path awaits
   `harness.beforeToolCall(layers, toolName, toolArgs, ctx)` before running the
   tool, and a layer hook returning a pending promise parks that tool call —
   nothing about the gate assumes a synchronous answer.
2. **The gate is correlated with the event stream.** `BeforeToolCallParams`
   carries the `callId` of the pending call — the same id the
   `tool_call_started` framework event carries — so a gating layer can tie its
   decision to the `tool_call` it is reported as. Without the id, a permission
   layer cannot tell the editor *which* pending call it is asking about.
3. **The event precedes the gate.** `tool_call_started` is emitted before the
   gate is awaited, on every tool-executing path, so a parked call is visible
   as `pending` rather than invisible until approved.

`beforeToolCall` remains a veto tier as spec 27 describes — its `allow` also
means "no hook had an opinion" — which is exactly right here: the permission
layer is decisive for `deny` and `ask`, and abstains into the default
otherwise. Layers ahead of it in slot order can still deny first; a steering
rule that already refuses a call is never escalated to the editor.

## Slash commands

`options.commands` is advertised to the client as an
`available_commands_update` notification right after each session opens (this
wire revision's `session/new` response has no commands field):

```ts
commands: [
  {
    name: 'plan',
    description: 'Plan the work without making edits',
    inputHint: 'what to plan',   // shown by clients as the argument hint
    run: (args, session) => `Plan only — do not edit files.\n\n${args}`,
  },
],
```

A prompt beginning with `/name` is routed to the command's `run`, whose return
value (a `string` or `Item[]`) becomes the turn's input; a command without
`run` forwards its text unchanged, useful when the graph itself interprets it.
Only the command *name* is tokenized — the argument text reaches `run` raw
(one separator stripped), so newlines and code blocks survive — and content
blocks after the command block (images, embedded context) are appended to the
turn rather than discarded. Commands are advertisement plus routing — they
hold no state and open no side channel; whatever they return runs as an
ordinary turn.

## History and `session/load`

Providing `options.history` — the two-method seam `29` established —
advertises `loadSession`:

```ts
history: {
  load: (sessionId: string) => Promise<ReadonlyArray<Item> | null>,
  save: (sessionId: string, item: Item) => Promise<void>,  // append one item
},
```

`session/load` loads the stored items, installs them with
`seedSessionHistory(sessionId, items)`, and replays them to the client as
`session/update` notifications — in item order, tool calls and their outputs
included — before responding, as the protocol requires. Loading a session
that is already live is refused (`invalidParams`): its pumps are running
against the existing entry.

On the write side, **input items are appended through `save` before the turn
executes** (a user prompt must survive a crash mid-turn), and the server pumps
completed items from `getItemStream({ threadId: sessionId })` into `save`,
deduplicated by item id — the stream emits cumulative snapshots, and replays
after reattach must not duplicate stored history (the same rule as `29`'s
persistence pump). Snapshots still marked `in_progress` are skipped without
registering their id, so the finalized copy is the one persisted. Without
`history`, `loadSession` is not advertised and sessions are process-lifetime.

## Serving an agent that delegates

A served harness whose graph contains `step.acpAgent` (or `acpAgentTool()`) is
an ACP **proxy**: the client drives Noetic, and Noetic drives Claude Code,
Codex, or another served Noetic harness underneath. The client direction
already emits every nested notification as `acp.*` passthrough events; the
server forwards the sub-agent's `tool_call` / `tool_call_update` / `plan`
traffic to the editor, shape-validated before it can reach the wire (a
malformed nested update is dropped, never sent) and with its tool-call ids
namespaced under a `sub:` prefix so they can never collide with a first-party
call's id. The editor watches file edits happen three layers down. Permission
requests raised by the *sub-agent* are answered by the step's own three-tier
resolver as spec 27 defines; routing them onward to a person is
`askUserForPermission()` on the step plus the full harness's spec-27
permission-channel API (`getChannelStream`/`getChannelHandle` — harness
surface, deliberately outside the `AcpServeHarness` subset), not a special
case.

## What the server refuses to be

The server maps the protocol onto the harness's existing public surface —
`execute`, the streams, `seedSessionHistory`, `abort` — and nothing else. It
does not reach into the interpreter, run steps outside the item log, or hold
state the harness cannot see, for the same reason spec 27's inspection surface
is read-and-interrupt only: a turn run behind the runtime's back would bypass
usage accounting, the event stream, and durability. If the server needs a
capability, the harness contract grows it publicly first.

## Future Considerations

- **`max_turn_requests`** — the wire defines it, but core has no
  turn-request-limit error kind to map from; when one exists, the pump's
  errorKind table grows a row.

- **Protocol v2 / library bump.** Upstream's draft second revision restructures
  the turn (`session/prompt` acks immediately; completion flows through
  `state_update`), adds `session/resume` with replay cursors, session config
  options (`config_option_update` — a natural surface for exposing harness
  `params` and modes to the editor), `elicitation/create` (a structured-input
  surface for clarifying-question compositions, cf. `29`'s modal note), and
  `usage_update` (backed by `getUsage`). These land with a version bump of
  `@zed-industries/agent-client-protocol`; the `history` and `commands` seams
  are shaped to absorb them.
- **Session modes** mapped to steering configs or graph variants
  (`setSessionMode` → an author-provided `onModeChange`).
- **MCP server passthrough** — `session/new` carries `mcpServers` the harness
  could mount as tools.
- **OpenUI over ACP** — rendering `28`'s fragments through ACP's content
  blocks where clients grow support.
- **A CLI entry** (`noetic serve --acp`) in the CLI repo, wrapping `serveAcp`.
