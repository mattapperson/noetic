# 27 — ACP Agent Steps

A Noetic step can delegate a turn to an external coding agent — Claude Code,
Codex, Gemini CLI, anything that speaks the protocol — exactly the way
`callModel` delegates a turn to a language model. The integration is the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP): a JSON-RPC 2.0
standard in which **Noetic is the Client and the coding agent is the Agent**.

Because every ACP agent is a uniform JSON-RPC peer, there are no per-vendor SDKs
and no closed set of supported agents. One step kind, one package, one adapter
shape.

## Why the protocol, not an SDK per agent

ACP is bidirectional. The agent does not reach for the machine itself: it asks
the client to read files, write files, and run terminals, and it asks permission
before running a tool. Implementing the client side means **a sub-agent's file
and shell access flows through Noetic's own adapters** — the same sandboxing,
virtual filesystem, and audit path as first-party steps — instead of around
them through a vendor SDK.

It also brings capabilities that have no representation in a hand-rolled
adapter: permission requests, plans, session modes, slash commands, MCP server
passthrough, multimodal prompts, typed stop reasons, and cancellation semantics.

## Packages

```
acp ──→ types          (core never imports acp)
core ─→ types          (resolves agents via contract + registry)
```

- **`@noetic-tools/types`** — the contract: `AcpAgent`, `AcpAgentConnection`,
  `AcpSession`, `AcpTransport`, `AcpClientHost`, the permission types, and
  `StepAcpAgent`. It lives here — next to `ContextLayer` — so both `core` and
  `acp` depend on it without forming a cycle. Protocol types are re-exported
  verbatim from `@zed-industries/agent-client-protocol` rather than mirrored, so
  the wire surface cannot drift from the specification.
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
  close(): Promise<void>;
}

interface AcpSession {
  readonly sessionId: string;
  readonly modes?: AcpSessionModeState;
  readonly availableCommands: ReadonlyArray<AcpAvailableCommand>;
  prompt(opts: AcpPromptOptions): Promise<AcpTurnResult>;
  cancel(): Promise<void>;
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
}
```

A capability the agent did not advertise is refused **before anything reaches
the wire**, with `AcpCapabilityError` — loading a session, switching mode or
model, sending image/audio/embedded content, or naming an HTTP/SSE MCP server.
A connection that cannot be established raises `AcpConnectError`.

## Transport

ACP rides on a bidirectional byte stream:

```ts
interface AcpTransport {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}
```

This is deliberately **not** built on `SubprocessAdapter` — that contract returns
a durable handle with no attached stdio — nor on `ShellAdapter`, which is
one-shot. Three transports ship:

| Transport | Use |
|---|---|
| `stdioAcpTransport` (`@noetic-tools/acp/stdio`) | A local agent as a child process. The default for every preset, loaded through a lazy `import()`. |
| `loopbackTransport` | An in-process agent. Runs the real wire protocol with no process — the recommended way to test an ACP-backed step. |
| custom | Anything yielding a duplex byte stream: a socket, a sandbox bridge, a remote host. |

## Client-side capabilities

`@noetic-tools/acp` implements the ACP `Client` interface against an
`AcpClientHost` the runtime builds from `Context`:

| ACP client method | Backing |
|---|---|
| `fs/read_text_file` | `ctx.fs.readFileText`, with the spec's 1-indexed `line`/`limit` window |
| `fs/write_text_file` | `ctx.fs.writeFile`, parent directories via `ctx.fs.mkdir` |
| `terminal/create`·`output`·`wait_for_exit`·`kill`·`release` | A terminal registry over `ctx.shell.exec`: `onData` feeds an `outputByteLimit` ring buffer, one `AbortController` per terminal backs `kill`, and `ShellExecResult.exitCode` becomes the exit status |
| `session/request_permission` | The permission resolver (below) |
| `session/update` | The event bridge (below) |

Advertised `ClientCapabilities` are computed from what the host can actually
back, narrowed by the step's `clientCapabilities`. A withdrawn capability is
answered with a JSON-RPC method-not-found rather than quietly doing the work
anyway — a read-only review step genuinely cannot write.

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

When all three abstain, the policy `default` applies — **`deny` unless the step
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
assistant text (or the parsed `output`).

### Prompt content

`prompt` carries plain text; `content` carries the full ACP `ContentBlock[]` —
images, audio, resource links, embedded context — appended after it. The
specification requires clients to restrict content to what the agent advertised,
so an unsupported block raises `AcpCapabilityError` before the turn is sent.

An empty `prompt` means "use the step's runtime input as the prompt".

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
| `'harness'` | kept until the caller runs `harness.closeAcpSessions()` — nothing closes it for you |

`session.reuse` shares a kept connection under an id, so later steps take their
turns against the same agent. It requires `keepAlive: 'run'` or `'harness'`: a
connection closed at the end of its step has nothing left to share, so naming a
reuse key without a scope raises `ACP_REUSE_WITHOUT_KEEPALIVE` rather than
silently upgrading the scope on the step's behalf.

```ts
// Shared for the rest of this run, collected automatically.
session: { reuse: 'bugfix', keepAlive: 'run' }

// Kept past the run — a warm agent across several harness.execute() calls.
// The caller owns it: `await harness.closeAcpSessions()` when done.
session: { reuse: 'assistant', keepAlive: 'harness' }
```

`session.load` resumes an existing ACP session id via `session/load` instead of
creating a new one.

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
| `agent_thought_chunk` | `response.reasoning.delta` |
| `tool_call` | `response.output_item.added` (function_call) + `response.function_call_arguments.delta`/`.done` + `response.output_item.done` |
| `user_message_chunk`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update` | `acp.<sessionUpdate>` (full stream only) |

As a result `getTextStream()`, `getReasoningStream()`, `getItemStream()`, and
`getFullStream()` all surface ACP output. Every notification is *also* emitted
raw as an `acp_event` framework event for protocol-native consumers.

**A turn always emits its output.** The bridge brackets every turn with
`response.created` (on `begin()`) and `response.completed` carrying the stop
reason (on `finalize()`), so even an agent that streams nothing emits a
lifecycle — and `finalize()` synthesizes the text and tool-call events from the
result when the stream carried none. `emit: false` suppresses all of it.

Items follow the same rule: assistant text becomes a `MessageItem`, a `tool_call`
becomes a `FunctionCallItem`, and a completed `tool_call_update` becomes a
`FunctionCallOutputItem` whose output renders the ACP content structurally —
diffs and terminal references included, never dropped.

## JSON workflow nodes

One node kind, with the agent named by a registry key:

```json
{
  "kind": "acp-agent",
  "id": "review",
  "agent": "claude-code",
  "prompt": "Review the diff",
  "mode": "plan",
  "permissions": { "default": "deny", "allow": [{ "kind": "read" }] }
}
```

The hydrator resolves `agent` from `HydrationContext.acpAgents`, an **open**
registry: supporting a new agent needs another entry, not a schema change. An
unregistered reference fails hydration with `UNKNOWN_ACP_AGENT_REFERENCE`. The
published JSON Schema is regenerated from the Zod source (`bun run gen:schema`).

## Core decoupling invariant

`@noetic-tools/core` imports only the *contract types* from
`@noetic-tools/types` and resolves *agent instances* from the step
(`step.agent`) or the hydration registry. It never imports `@noetic-tools/acp`,
so neither the protocol library nor any agent binary enters core's dependency
graph. This is enforced by `.sentrux/rules.toml` (`core → acp` forbidden, and
the reverse).

## Future Considerations

- **ACP server direction** — expose an `AgentHarness` as an ACP Agent over
  stdio, so Zed and other ACP clients can drive a Noetic harness. The contract
  and package layout leave room for it; nothing in the client direction assumes
  it is absent.
- Protocol features still in draft upstream (`session/resume`, `session/list`,
  `elicitation/*`, session config options, usage reporting) arrive with a
  version bump of `@zed-industries/agent-client-protocol`.
- Feeding ACP `plan` updates into the plan context layer, so a sub-agent's plan
  becomes part of the host agent's visible state.
