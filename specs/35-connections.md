# 35 — Connections

> **Depends On:** `01-step-type` (Step), `08-runtime` (AgentHarness), `09-error-model` (NoeticError, NoeticConfigError), `10-observability` (Span), `11-context-layer-system` (ContextLayer), `23-durable-execution` / `23a-step-level-resume` (checkpoint, ledger), `26-json-workflow-runtime` (WorkflowDocument), `33-expressions` (Expression), `34-custom-items` (custom items), `36-connection-profiles` (Profile, Extension)
> **Exports:** `Connection`, `ConnectionProvider`, `ConnectionManifest`, `ConnectionEvent`, `ConnectionReference`, `ConnectionSubscription`, `WebhookReceiver`, `connection()`, `connectionTools()`, `connectionObservations()`, `defineTrigger()`, `cronTrigger()`, `createInMemoryConnection()`, `step.connectionCall`, `step.subscribeEvents`, `step.awaitEvent`, `step.awaitTask`, `createWebhookReceiver()` (`@noetic-tools/platform-node`), `mcpConnection()` (`@noetic-tools/mcp`)

---

A **connection** is a named, live surface the agent acts on and hears from: an
iOS simulator, an Android emulator, a browser, a desktop, a Slack workspace, a
Teams tenant, a deploy pipeline. A harness holds any number of them. Each one
offers **operations** (things to do), **resources** (state to observe),
**tasks** (operations that outlive a call) and **events** (things that happened
upstream), described by the versioned **profiles** and **extensions** of
`36-connection-profiles`.

Connections are reached over the Model Context Protocol: tools for operations,
resources for observations, the
[Tasks extension](https://modelcontextprotocol.io/seps/2663-tasks-extension)
(`io.modelcontextprotocol/tasks`, SEP-2663) for long-running work, and the
[Events extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415)
(`io.modelcontextprotocol/events`, SEP-3415) for upstream events. Anything that
speaks a profile plugs in, from any vendor, in any language. A connection can
also be implemented in-process — for tests, and for **triggers**, the
programmatic event sources a harness owns — and behaves identically.

## Connections are not platform adapters

The harness already takes four typed adapters (`08-runtime`): `fs`, `shell`,
`subprocess` and `storage`. They stay. The runtime itself depends on them —
context layers persist through `storage`, `runCode` dispatches through
`subprocess` — so they must be in-process, fast enough for the interpreter, and
present in every harness. Connections are the opposite: the runtime never
depends on one, a harness may have none, and each one is something the *agent*
operates, not something the *runtime* is built on.

The test for a new surface: if a context layer or the interpreter must call it,
it is an adapter; if a model, a step or a workflow calls it, it is a
connection.

## Packages

```
@noetic-tools/core ─────────────→ @noetic-tools/types   (connection contract, profile format)
@noetic-tools/mcp ──────────────→ @noetic-tools/types   (+ MCP SDK)
@noetic-tools/agent-plugins ────→ @noetic-tools/mcp, @noetic-tools/types
@noetic-tools/profile-screen ───→ @noetic-tools/types
@noetic-tools/profile-browser ──→ @noetic-tools/profile-screen, @noetic-tools/types
@noetic-tools/profile-device ───→ @noetic-tools/profile-screen, @noetic-tools/types
@noetic-tools/profile-chat ─────→ @noetic-tools/types
@noetic-tools/profile-conformance → @noetic-tools/mcp, @noetic-tools/types
@noetic-tools/platform-node ────→ @noetic-tools/core    (webhook receiver)
```

- **`@noetic-tools/types`** owns the contract: `Connection`,
  `ConnectionProvider`, the event envelope, references, `WebhookReceiver`, and
  the profile format (`defineProfile`, `defineExtension`, spec 36).
- **`@noetic-tools/core`** owns the harness integration: the connection
  registry, instance lifecycle, model tools, observation layers,
  subscriptions, triggers, the step variants, the JSON nodes and durability.
- **`@noetic-tools/mcp`** is the MCP bridge: `mcpConnection()` turns an MCP
  server into a `ConnectionProvider`. It owns the MCP client, transports
  (stdio, Streamable HTTP, SSE), capability discovery, the Tasks and Events
  clients, and Standard Webhooks verification. It is the only package that
  imports the MCP SDK; `@noetic-tools/agent-plugins` reaches MCP servers
  through it.
- **`@noetic-tools/profile-*`** each publish one profile (spec 36): its
  schemas, its TypeScript types and its conformance scenarios.
- **`@noetic-tools/profile-conformance`** runs a profile's conformance
  scenarios against any server.
- **`@noetic-tools/platform-node`** provides `createWebhookReceiver()`.

### Core decoupling invariant

`@noetic-tools/core` imports only contract types from `@noetic-tools/types`. It
never imports `@noetic-tools/mcp`, the MCP SDK, or any profile package; it
receives `ConnectionProvider`s from configuration and profile objects from the
caller. Profile packages never import `@noetic-tools/mcp`. Only
`@noetic-tools/mcp` imports the MCP SDK. All three are enforced by
`.sentrux/rules.toml` boundaries, which also give each new package a layer.

## Terms

| Term | Meaning |
|---|---|
| **Profile** | A versioned vocabulary of operations, resources and events, e.g. `chat@1.2.0` (spec 36). |
| **Extension** | A vendor's versioned addition, identified by reverse domain, e.g. `com.slack.blocks@3.0.0`. |
| **Connection** | A live instance the harness holds, under a name the harness author chooses: `ios`, `android`, `slack`. |
| **Provider** | What creates connections. One MCP server may provide several instances (one emulator server, two devices). |
| **Slot** | A workflow's own name for a connection it needs; bound to an instance when the workflow runs. |
| **Operation** | A named call: `screen.tap`, `chat.reply`, `com.acme.ios-permissions.grant`. |
| **Event type** | A named upstream occurrence with an arguments schema and a payload schema: `chat.message.created`. |
| **Subscription** | A durable, identified interest in one event type with fixed arguments. |
| **Reference** | An id a connection hands out (a thread, a message, a task), carried with the instance that issued it. |
| **Trigger** | An in-process event source defined with `defineTrigger()`; a connection that offers only events. |

## The contract

```ts
interface ConnectionProvider {
  /** Opens every instance this provider offers. */
  connect(opts: ConnectionConnectOptions): Promise<ReadonlyArray<Connection>>;
}

interface ConnectionConnectOptions {
  signal: AbortSignal;
  storage: ScopedStorage;           // provider-private, e.g. webhook secrets
  webhooks?: WebhookReceiver;       // present when the harness can receive webhooks
}

interface Connection {
  /** The provider's id for this instance; the harness maps it to its own name. */
  readonly instanceId: string;
  /** Profiles, extensions, operations, resources and event types this instance offers. */
  readonly manifest: ConnectionManifest;
  /** Fires when the manifest changes (a server upgrade, a list_changed notification). */
  onManifestChanged(listener: (manifest: ConnectionManifest) => void): () => void;
  call(op: string, args: unknown, opts: ConnectionCallOptions): Promise<ConnectionCallResult>;
  readResource(uri: string, opts: { signal: AbortSignal }): Promise<ConnectionResource>;
  readonly tasks: ConnectionTasks;
  readonly events: ConnectionEvents;
  /** Resolves when the instance becomes unavailable; carries the reason. */
  readonly closed: Promise<ConnectionClosed>;
  close(): Promise<void>;
}

interface ConnectionCallOptions {
  signal: AbortSignal;
  /** Deterministic per logical call; servers dedupe side effects on it (spec 36 § Idempotency). */
  idempotencyKey: string;
}

type ConnectionCallResult =
  | { kind: 'complete'; value: unknown }
  | { kind: 'task'; taskId: string; pollIntervalMs?: number };

interface ConnectionTasks {
  get(taskId: string): Promise<ConnectionTaskState>;
  /** Answers a task's outstanding input requests. */
  update(taskId: string, inputResponses: Record<string, unknown>): Promise<ConnectionTaskState>;
  cancel(taskId: string): Promise<void>;
  /** Pushed task updates when the connection supports them; otherwise the harness polls `get`. */
  watch?(taskId: string, opts: { signal: AbortSignal }): AsyncIterable<ConnectionTaskState>;
}

type ConnectionTaskState =
  | { status: 'working'; pollIntervalMs?: number }
  | { status: 'input_required'; inputRequests: Record<string, ConnectionInputRequest> }
  | { status: 'completed'; result: unknown }
  | { status: 'failed'; error: ConnectionOperationError }
  | { status: 'cancelled' };

interface ConnectionEvents {
  subscribe(req: ConnectionEventRequest): ConnectionEventStream;
}

interface ConnectionEventRequest {
  type: string;
  /** Validated against the event type's arguments schema (server-side filters). */
  arguments: Record<string, unknown>;
  /** `null` starts from now. */
  cursor: string | null;
  signal: AbortSignal;
}

interface ConnectionEventStream extends AsyncIterable<ConnectionEventBatch> {
  /** Resolves once the subscription is established upstream and its start cursor is known. */
  readonly ready: Promise<{ cursor: string | null }>;
  /** Resolves if the upstream ends the subscription. */
  readonly terminated: Promise<{ reason: string }>;
  close(): Promise<void>;
}

interface ConnectionEventBatch {
  events: ConnectionEvent[];
  /** Position after this batch; `null` for event types without replay. */
  cursor: string | null;
  /** True when the upstream skipped events before this batch. */
  truncated: boolean;
}
```

`@noetic-tools/core` ships `createInMemoryConnection()`, a scripted
implementation of the full contract (operations as functions, events pushed by
the test, tasks settled by the test), so every behavior in this spec is
testable without MCP.

### The event envelope

Every event, from every source — an MCP server, a webhook, a trigger, host code
— reaches the harness in one shape:

```ts
interface ConnectionEvent<TPayload = unknown> {
  id: string;            // SEP-3415 eventId
  type: string;          // SEP-3415 name
  time: string;          // SEP-3415 timestamp (ISO 8601)
  payload: TPayload;     // SEP-3415 data, validated against the payload schema
  cursor: string | null; // SEP-3415 cursor
  meta?: Record<string, unknown>;  // SEP-3415 _meta
  /** Harness instance name, stamped by the harness on receipt. */
  source: string;
}
```

It is SEP-3415's event occurrence with its fields renamed to match Noetic's
item vocabulary and `source` added. Payload fields an extension adds sit under
`payload.ext["<extension id>"]` (spec 36), so a consumer validating against the
profile's schema always succeeds.

## Harness configuration

```ts
const harness = new AgentHarness({
  environment: {
    connections: {
      ios:     iosSimulator,                                       // a provider with one instance
      android: { provider: emulators, instance: 'Pixel_8_API_35' }, // pick one of several
      slack:   { provider: mcpConnection({ url: 'https://slack-mcp.example.com/mcp' }),
                 policy: { approve: ['chat.post'], deny: ['com.slack.admin.*'] } },
      teams:   { provider: mcpConnection({ command: 'teams-mcp', args: [] }),
                 policy: { approve: ['chat.*'] } },
      deploys: deployTrigger,                                      // defineTrigger(), see Triggers
    },
    webhooks: createWebhookReceiver({ port: 8787, publicUrl: 'https://agent.example.com' }),
  },
});
await harness.start();
```

- **Names are the harness author's.** Every surface below — tool targets,
  event `source`, storage keys, policy, references — uses the configured name,
  never the provider's `instanceId`.
- **One provider, several instances.** A provider that offers more than one
  instance is configured once per name, with `instance` selecting which.
- **Start.** Construction is synchronous and only validates configuration.
  `harness.start()` — called implicitly by the first `execute()` or `run()` —
  connects every provider, negotiates each instance (§ Negotiation), builds the
  model tool pool, starts triggers and subscriptions, and checks the
  harness's own `agentGraph` slots. Setup failures surface here as
  `NoeticConfigError`s (§ Errors).
- **Unavailable instances.** An instance whose `closed` resolves is marked
  unavailable: its tools return a tool error naming it, its steps fail with
  `connection_unavailable`, its subscriptions pause with their cursors kept,
  and every other instance keeps working. The harness reconnects with backoff
  and resumes subscriptions from their stored cursors. Status is observable
  through `harness.getConnectionStatus(name?)` and the
  `connection_state_changed` framework event.
- **Manifest changes.** When an instance's manifest changes, the harness
  renegotiates it. If it still satisfies every slot bound to it, the tool pool
  is rebuilt and takes effect at the next turn, never mid-turn. If it no longer
  does, the instance is marked unavailable with reason `manifest_unsatisfied`.
- **Renaming is a new connection.** Durable state is keyed by name; a renamed
  instance starts with no cursors, inbox, tasks or references.

## Connection registry

Steps, tools and hydrated workflows never hold a provider's `Connection`
object. They resolve instances by name through the harness's
**connection registry** (`ctx.connections`) at the moment they execute. The
registry wraps each live connection with everything the harness owns:
reference wrapping and checking, the gate chain, unavailability, reconnection
and renegotiation. A step that runs after a reconnect therefore uses the new
connection, and no code path can call a server around the harness.

## Negotiation and versions

An MCP server declares what it implements under the `tools.noetic/profiles`
key of its `extensions` capability (spec 36 § Wire declaration): profile and
extension versions, and for a multi-instance server, each instance with its own
profiles and extensions. `mcpConnection()` reads the declaration during
capability discovery and validates the server's tools and event types against
the declared profile schemas. An instance whose tools contradict its declared
profile is marked unavailable with reason `profile_mismatch`, so a
non-conforming server is caught at connect time rather than on first use.

Requirements — from a `connection()` slot in TypeScript or a document's
`connections` manifest — are semver ranges per profile and per extension, plus
the optional operations and event types the slot needs:

```ts
connection('phone', {
  profile: device.range('^1.2'),
  extensions: [iosPermissions.range('^1')],
  ops: ['device.test.run'],          // optional profile parts this slot depends on
});
```

A profile range implies its parents' ranges (spec 36 § Inheritance), so
`device@^1.2` also requires the `screen` range that `device@1.2.0` declares.
An unsatisfied requirement fails with `CONNECTION_VERSION_UNSATISFIED`, a
missing extension with `CONNECTION_EXTENSION_MISSING`, and a missing optional
part with `CONNECTION_OPERATION_UNSUPPORTED`, each naming the slot, the
instance, the requirement and what the instance offers.

## The gate chain

Every connection call — from the model, from a `connectionCall` step, from a
JSON node — passes through the same gates `invokeTool` does (`08-runtime`
§ Tool approval), in order:

1. **Declaration.** The operation is in the instance's manifest and, for steps
   and nodes, declared by the slot.
2. **Validation.** `args` against the operation's input schema.
3. **References.** Every reference in `args` is one the harness issued (§
   References); the call is routed to the instance it names.
4. **Instance policy.** `allow` / `deny` / `approve` globs over operation
   names, evaluated against the instance the call is routed to.
5. **`beforeToolCall` layers** and the **harness approver**, with the instance,
   operation and call origin (`model`, `step`, `workflow`) in the call
   metadata.

A refusal throws `steering_denied` for steps and returns a tool error to the
model. Author-written steps are gated like everything else, so a policy holds
whatever path a call takes.

## Model-facing tools

Each instance's operations become `Tool`s in the harness tool pool unless the
instance is configured with `expose: 'none'` (or `expose: 'profiles'`, which
leaves out extensions).

**Shared tools across instances.** Operations are grouped by the profile major
that defines them. When two or more instances offer the same operation of the
same profile major, the harness exposes one tool with a required `target`
argument whose enum lists those instances. `screen.tap` is defined by
`screen@1`, so an `ios` device, an `android` device and a `chrome` browser all
share one `screen_tap` tool with `target: 'ios' | 'android' | 'chrome'`. With a
single instance, `target` is optional and defaults to it. The shared tool's
input schema is the operation's schema at the lowest profile minor among its
targets, so every target accepts every call.

**Per-instance tools.** An extension operation, and any profile operation an
instance's extension adds input fields to (spec 36 § Adding fields), is also
exposed per instance with the instance's full schema:
`ios__com_acme_ios-permissions_grant`, `slack__chat_post`. Its description says
it is specific to that instance, so the model prefers the portable tool when
both would work.

**Tool names.** `.` maps to `_` and `__` separates an instance prefix. When
instances run different majors of one profile, each major's tools carry the
major: `chat_reply` for `chat@1`, `chat_v2_reply` for `chat@2`. A collision
after mapping fails `harness.start()` with `CONNECTION_TOOL_COLLISION`.

**Selection per call.** A `callModel` step narrows what it offers with
`connectionTools(slot, { ops })`, where `ops` is a list of operation names or
globs (`'screen.*'`). The tools resolve through the registry when the step
runs, not when it is built. The JSON form is a tool entry
`{ "type": "connection:<slot>", "ops": [...] }`.

## Observations

A profile's observed resources become one context layer per instance,
`connectionObservations(name)`, added automatically for every exposed
instance. Each layer has its own budget, so a busy channel cannot crowd a
device's screen out of the window. The layer reads its resources in `recall`,
using `resources/subscribe` notifications to refresh only what changed, and
renders images (screenshots) as image content. Which resources a layer includes
is the profile's `observe` set, overridable per instance with `observe: [...]`.

## References

Operations, events and tasks return ids that only mean something on the
instance that issued them. A profile marks those fields as references (spec 36
§ References); the harness wraps each one on the way in:

```ts
interface ConnectionReference {
  $ref: { instance: string; kind: string; id: string };  // kind: 'chat.thread', 'device.app', 'task', …
}
```

- **Routing.** A call is routed to the instance its references name. A `target`
  that contradicts a reference fails with `connection_reference_mismatch`;
  references to two instances in one call fail the same way.
- **Provenance.** The harness records every reference it issues, per thread,
  in the harness `StorageAdapter`. A reference in `args` that the harness did
  not issue to the same thread is rejected with `connection_reference_rejected`.
  A model, a tool result or an LLM-authored document cannot forge a reference
  to reach another instance, another thread's resources, or a task it did not
  start. Profiles may declare reference kinds `public` (spec 36), such as a
  channel id a user can type; those skip the provenance check but are still
  routed and gated.
- References survive serialization, checkpoints and JSON workflow data
  unchanged.

## Tasks

Task creation is server-directed (SEP-2663). The bridge declares
`io.modelcontextprotocol/tasks` in its per-request client capabilities on every
`tools/call`, so any operation may return a task; a profile's `task` field
(spec 36) only states what a conforming server must do. A call that returns a
task yields a reference of kind `task`.

- **Waiting.** By default a `connectionCall` waits for the task and returns its
  result. It follows `watch` when the connection offers pushed updates
  (`notifications/tasks`), otherwise polls `tasks/get` at the server's
  `pollIntervalMs`. The model-facing tool does the same, streaming task status
  as tool progress events.
- **Starting.** `connectionCall` with `await: false` returns the task reference
  at once; `awaitTask` waits for it later. This is how a flow starts a long test
  run on a device and keeps working.
- **Input required.** A task in `input_required` carries `inputRequests`
  (SEP-2322). The harness answers them: an elicitation request goes to the
  approval channel as a question for a person, and its answer returns through
  `tasks/update`; a sampling request runs on the harness's model provider. A
  harness with no approval channel, or an `awaitTask` with
  `onInput: 'fail'`, fails with `connection_input_required`.
- **Cancellation.** Aborting the step, the turn or the harness cancels the task
  through `tasks/cancel`, unless the call set `detach: true`.

### Durability

Each logical call has a deterministic **idempotency key**: the execution id plus
the step's ledger key (`23a-step-level-resume` § Identity), or the turn id plus
the tool call id for model calls. The bridge sends it as
`_meta["tools.noetic/idempotency-key"]`, and profiles require servers to honor
it for every operation with side effects (spec 36 § Idempotency): a repeated
key returns the original outcome — the same result, or the same task — without
repeating the effect.

- A `connectionCall`, `awaitTask` or `awaitEvent` step writes a **pre-dispatch
  ledger entry** before it reaches the server: the key, and once known, the task
  reference, the subscription and its start cursor, and the deadline. On resume
  a step with a pre-dispatch entry and no completion reattaches — it re-sends
  the call with the same key, which returns the existing task or result, and
  waits again — instead of starting a new effect.
- A task the server no longer knows fails with `task_lost`.
- Model-initiated calls carry their key too, so a tool call re-run under the
  `23a` round rules returns the original outcome from any conforming server.
  Against a server that does not honor keys, connection calls are at least
  once, like any tool.

Task references share the ledger and reattach mechanics of `SubprocessAdapter`
handles (`23-durable-execution`) but are their own type: an MCP task is owned
by a remote server with its own lifetime, not by the host.

## Events

Events reach the harness in three delivery modes, all defined by SEP-3415:

| Mode | Wire | When the bridge uses it |
|---|---|---|
| Push | `events/stream` | The server supports it and the transport keeps a connection open. |
| Webhook | `events/subscribe` with a callback URL | The server supports it and the harness has a `WebhookReceiver`. |
| Poll | `events/poll` | Fallback, at the server's interval hint, default 30 s. |

The connection chooses the mode per subscription, preferring push, then
webhook, then poll; an instance can pin one with `delivery: 'webhook'`.
Consumers never see the difference. Heartbeat cursors advance the stored
cursor even when no events match.

### Webhook receiver

```ts
interface WebhookReceiver {
  /** Public URL a server should POST to for this registration. */
  register(registration: WebhookRegistration): Promise<WebhookEndpoint>;
  unregister(endpointId: string): Promise<void>;
}
```

`@noetic-tools/platform-node`'s `createWebhookReceiver()` serves the endpoints
over HTTP; a serverless host implements the same interface over its own
routing. The bridge registers one endpoint per subscription and keeps a
per-subscription secret in provider storage. For each delivery it:

- verifies the Standard Webhooks signature and rejects a `webhook-timestamp`
  more than five minutes from now;
- drops a `webhook-id` it has already accepted;
- dispatches control envelopes — `terminated` ends the subscription, `gap`
  becomes a batch with `truncated: true` — and turns event envelopes into
  batches;
- refreshes the subscription before its TTL lapses.

Requests failing verification are rejected and counted, never delivered.

### Subscriptions

A **subscription** is a durable interest in one event type with fixed
arguments. It has a stable `id`, and its identity upstream is
`(instance, type, arguments)`. Nothing is subscribed until a subscription or an
event step asks for it.

- **Cursors.** Each subscription's cursor lives at
  `connections/<instance>/subscriptions/<id>/cursor` in the harness
  `StorageAdapter`. An event type whose cursor is `null` has no replay: events
  that arrive while the harness is down are lost, by the upstream's definition.
- **Duplicates.** Deduplication is per subscription on the event `id`, as
  SEP-3415 scopes it: the same event on two subscriptions reaches both.
- **Gaps.** A truncated batch emits an `event_gap` framework event naming the
  subscription. A subscription with `onGap: 'fail'` instead fails its waiting
  step with `event_gap`; the default is to continue.
- **Termination.** An upstream termination (`notifications/events/terminated`,
  a `terminated` webhook envelope, a poll answered `Forbidden` or `NotFound`)
  emits `subscription_terminated` and fails any step waiting on it with
  `connection_subscription_terminated`. Harness subscriptions retry with
  backoff; the stored cursor is kept.

### Harness subscriptions

Harness subscriptions declare which events start or join a turn.

```ts
new AgentHarness({
  subscriptions: [
    {
      id: 'slack-mentions',                     // stable; keys durable state
      source: 'slack',                          // an instance name
      event: 'chat.message.created',
      arguments: { mentionsAgent: true },       // server-side filter
      filter: (e) => !e.payload.author.isBot,   // client-side filter, or an Expression
      session: (e) => `slack:${e.payload.thread.$ref.id}`,
      input: (e) => e.payload.text,
      deliveryMode: 'next-turn',
    },
  ],
});
```

Delivery is durable end to end:

1. A batch's events that pass `filter` are written to the subscription's
   **inbox** (`connections/<instance>/subscriptions/<id>/inbox`), then the
   cursor advances. The inbox write and the cursor advance are one
   `StorageAdapter` write batch.
2. Each inbox entry is delivered as `harness.execute(input(event), { threadId:
   session(event), deliveryMode, messageId })` with `messageId` set to
   `<instance>:<subscription id>:<event id>`. The event is attached to the turn
   as a `noetic:connection_event` custom item (`34-custom-items`), so layers and
   steps can read its full payload and references.
3. The entry is marked done when its turn completes, and the subscription's
   **processed set** records its id (bounded by `processedRetention`, default
   1000 ids). On restart, entries not marked done are delivered again; an id in
   the processed set is never delivered again.

For a replayable event type this starts each matching event's turn exactly once
across crashes and redeliveries. The turn itself follows `23a`'s resume rules.

`session` defaults to `<instance>:<subscription id>`; `input` defaults to the
event rendered as a user-visible item; `deliveryMode` defaults to the harness
default.

## Triggers

A **trigger** is an event source the harness author defines in code: a cron, a
queue consumer, a file watcher, a database change feed, or plain host code
calling in. Triggers are connections that offer only events, so they get every
behavior above — the envelope, cursors, deduplication, subscriptions, the
inbox, event steps, JSON slots — with nothing trigger-specific in the runtime.

```ts
import { defineTrigger } from '@noetic-tools/core';

const deployTrigger = defineTrigger({
  id: 'com.acme.deploys',
  version: '1.0.0',
  events: {
    'com.acme.deploys.finished': { payload: DeployFinishedSchema },
    'com.acme.deploys.failed': { payload: DeployFailedSchema, arguments: DeployFilterSchema },
  },
  /** Optional: a source the harness runs. Omit for a push-only trigger. */
  async start({ emit, cursor, signal }) {
    for await (const msg of queue.consume({ after: cursor, signal })) {
      await emit({ type: 'com.acme.deploys.finished', id: msg.id, payload: msg.body, cursor: msg.offset });
    }
  },
});
```

- **Identity and versions.** A trigger is a standalone extension
  (`com.acme.deploys@1.0.0`, spec 36) with no profile, so its event types carry
  its id as a prefix like any extension's. Workflows require it like any other
  extension.
- **Arguments.** A trigger's event types may declare an arguments schema; the
  harness applies a subscription's arguments as a filter before the inbox, so
  subscriptions to a trigger behave like server-side filtered ones.
- **Pull sources.** `start` runs while the harness runs, restarts with backoff
  if it throws, and receives the last cursor any subscription to it has
  stored. `emit` resolves after every subscription has written the event to its
  inbox, so a source that awaits it never runs ahead of durable state.
- **Push from host code.** `harness.emit(name, { type, id, payload })` delivers
  an event into a trigger instance, validated against the trigger's schema.
  This is how a web handler, a test or another system raises an event without
  writing a source.
- **Schedules.** `cronTrigger({ id, schedule, timezone })` is a built-in
  trigger offering one event type, `<id>.tick`, whose event id is the scheduled
  time, so a tick missed during downtime is delivered once on restart, not
  repeatedly.

## Steps

```ts
import { connection, connectionTools, step } from '@noetic-tools/core';
import { device } from '@noetic-tools/profile-device';
import { chat } from '@noetic-tools/profile-chat';
import { iosPermissions } from '@acme/ios-mcp/profile';

const phone = connection('phone', { profile: device.range('^1.2'), extensions: [iosPermissions.range('^1')], ops: ['device.test.run'] });
const team  = connection('team',  { profile: chat.range('^1') });

const launch  = step.connectionCall({ connection: phone, op: 'device.app.launch', args: { bundleId: 'com.acme.app' } });
const grant   = step.connectionCall({ connection: phone, op: 'com.acme.ios-permissions.grant', args: (input) => ({ service: 'camera', app: input.app }) });
const run     = step.connectionCall({ connection: phone, op: 'device.test.run', args: { plan: 'smoke' }, await: false });
const done    = step.awaitTask({ connection: phone, task: (input) => input.task, timeout: 12e5 });

const replies = step.subscribeEvents({ connection: team, event: 'chat.message.created', arguments: (input) => ({ thread: input.thread }) });
const ask     = step.connectionCall({ connection: team, op: 'chat.reply', args: (input) => ({ thread: input.thread, text: 'Approve the release?' }) });
const answer  = step.awaitEvent({ subscription: (input) => input.subscription, filter: (e) => /approve/i.test(e.payload.text), timeout: 18e5 });

const agent = step.callModel({ tools: [connectionTools(phone, { ops: ['screen.*', 'device.app.*'] })], /* … */ });
```

- **Slots are declared, then bound.** `connection(slot, requirement)` declares
  a requirement. The harness collects every slot in `agentGraph` (as it
  collects tools) and binds each to the instance of the same name, or as given
  in `bindings: { phone: 'ios' }`. Those slots are checked at
  `harness.start()`. A step tree produced at run time (`dynamicWorkflow`,
  `harness.run(child)`) is checked before its own root executes. A connection
  step re-checks its operation against the live manifest when it runs, so a
  renegotiated instance fails cleanly with `CONNECTION_OPERATION_UNSUPPORTED`
  rather than with a server error.
- **Operations are typed by the slot.** `op` is a union of the operations the
  slot's profile, its parents and its declared extensions define; `args` and
  the output are typed by that operation's schemas. Optional operations not
  listed in `ops` are typed as possibly unsupported.
- **Step variants.** `connectionCall`, `subscribeEvents`, `awaitEvent` and
  `awaitTask` join the `Step` union, spelled the same in TypeScript and JSON.
  Each writes a pre-dispatch ledger entry (§ Durability) and records its result
  on completion, so resume replays or reattaches instead of repeating effects
  or waiting from scratch. Timeouts are milliseconds; the deadline is recorded
  in the pre-dispatch entry, so a resumed wait keeps its original deadline.
- **Not missing an event.** `subscribeEvents` establishes a subscription,
  waits for its `ready` cursor, records both, and returns a reference to it.
  `awaitEvent` given that subscription matches events from the recorded cursor
  onward, so the order subscribe → act → await cannot miss the event the action
  causes, across crashes too. `awaitEvent` given `connection` and `event`
  instead subscribes itself and sees only events after it is ready — enough
  when the event does not depend on the flow's own action. For an event type
  without replay neither form survives downtime.
- **Several instances per slot.** A slot with `min`/`max` binds to the
  instances listed in `bindings` for it; it never widens on its own when the
  harness gains an instance. `connectionCall` on such a slot takes `target`
  (an instance name, a function of the input, or `{ all: true }`, which calls
  every bound instance and returns `[{ instance, result }]`).

## JSON workflows

### The manifest

```json
{
  "version": 1,
  "connections": {
    "phone":   { "profile": "device@^1.2", "extensions": { "com.acme.ios-permissions": "^1.0" }, "ops": ["device.test.run"] },
    "droid":   { "profile": "device@^1.2", "extensions": { "com.acme.android-intents": "^1.0" } },
    "chats":   { "profile": "chat@^1", "min": 1 },
    "deploys": { "extensions": { "com.acme.deploys": "^1.0" } }
  },
  "subscriptions": [
    { "id": "failed-deploys", "connection": "deploys", "event": "com.acme.deploys.failed",
      "session": { "expr": "'deploys:' & payload.service" },
      "input": { "expr": "'Deploy of ' & payload.service & ' failed: ' & payload.reason" } }
  ],
  "root": { "kind": "sequence", "id": "main", "steps": [] }
}
```

- `connections` maps slot names to requirements: an optional `profile`
  (`name@range`), an optional `extensions` map (id → range), optional `ops`
  (optional profile parts the slot depends on), and `min`/`max` instance
  counts (default exactly one). A slot needs a profile, an extension or both.
  Every dependency carries a version range; a bare name is a validation error.
- `subscriptions` are harness subscriptions (§ Harness subscriptions) in JSON
  form, with expressions for `filter`, `session` and `input`, each evaluated
  against the event envelope. They are standing harness configuration, so they
  take effect only when the document is given to the harness at construction
  as its graph. `parseAndRunWorkflow` ignores them unless called with
  `{ subscriptions: 'activate' }`, and a document produced by `dynamicWorkflow`
  that declares any fails validation. Their lifetime is the harness's; their
  `id` keys their durable state, so the same document re-applied resumes the
  same subscriptions.
- Slots bind through the harness connection registry, by same name or by
  `HydrationContext.bindings` (slot → instance name or names). A multi-instance
  slot must be bound explicitly. Binding is checked before the root node
  executes.
- The resolved binding — instance, provider, server name and version, and the
  profile and extension versions that satisfied each slot — is recorded in the
  run's trace and checkpoint. Resuming against a binding that no longer
  satisfies the recorded requirement fails with `connection_binding_changed`.

### Host allowlist

A document's manifest says what it needs; the host decides what it may have.
`parseAndRunWorkflow` and `dynamicWorkflow` take a `connections` allowlist —
instance names, each with operation and event globs:

```ts
dynamicWorkflow({ connections: { ios: { ops: ['screen.*', 'device.app.*'] }, slack: { ops: ['chat.reply'], events: ['chat.message.created'] } } });
```

A manifest that asks for an instance, operation or event outside the allowlist
fails validation with `CONNECTION_ALLOWLIST_EXCEEDED`. With no allowlist a
document may bind nothing. `dynamicWorkflow` describes only the allowlisted
instances and operations to the model. Instance policy and the gate chain still
apply to every call the document makes.

### Nodes

```json
{ "kind": "connectionCall", "id": "launch", "connection": "phone", "op": "device.app.launch",
  "args": { "bundleId": "com.acme.app" } }

{ "kind": "connectionCall", "id": "grant", "connection": "phone", "op": "com.acme.ios-permissions.grant",
  "args": { "service": "camera", "app": { "expr": "app" } } }

{ "kind": "connectionCall", "id": "run", "connection": "droid", "op": "device.test.run",
  "args": { "plan": "smoke" }, "await": false }

{ "kind": "awaitTask", "id": "done", "connection": "droid", "task": { "expr": "task" }, "timeout": 1200000 }

{ "kind": "subscribeEvents", "id": "watch", "connection": "chats", "target": { "expr": "thread.$ref.instance" },
  "event": "chat.message.created", "arguments": { "thread": { "expr": "thread" } } }

{ "kind": "awaitEvent", "id": "approval", "subscription": { "expr": "subscription" },
  "filter": { "expr": "$contains(event.payload.text, 'approve')" }, "timeout": 1800000 }

{ "kind": "connectionCall", "id": "announce", "connection": "chats", "op": "chat.post",
  "target": { "all": true }, "args": { "channel": { "expr": "channel" }, "text": "Released." } }

{ "kind": "callModel", "id": "drive", "instructions": "…",
  "tools": [ { "type": "connection:phone", "ops": ["screen.*", "device.app.*"] } ] }
```

- **Every operation must be declared.** A node's `op`, a tool entry's `ops`,
  and a `subscribeEvents` or `awaitEvent` event must come from the profile
  (or its parents) or an extension the node's slot declares, and an optional
  profile operation must be listed in the slot's `ops`. Violations fail
  validation with `CONNECTION_OPERATION_UNDECLARED`.
- **Profile and extension operations are equals.** Both are called with the
  same node, and `args` are validated against that operation's own schema, not
  a reduced common form.
- **Expressions.** `args` values and `target` evaluate against the node's
  input, like every expression (`33-expressions`). `filter` on `awaitEvent`
  evaluates against `{ "event": <envelope>, "input": <node input> }`; a
  subscription's `filter`, `session` and `input` evaluate against the envelope.
  These are the only two evaluation inputs this spec adds to spec 33.
- **Output** is the operation's result, validated against its output schema and
  available to downstream `compute`, `conditional` and `routeSwitch` nodes.
  References in the output stay wrapped.
- **Multi-instance fan-out** uses `"target": { "all": true }`, or `inParallel`
  with `over` naming an array of instance names in the input.

Schema changes in `packages/types/src/schemas/workflow.ts`:
`WorkflowDocument.connections` and `WorkflowDocument.subscriptions`; the
`connectionCall`, `subscribeEvents`, `awaitEvent` and `awaitTask` node kinds;
and a `connection:<slot>` variant of `CallModelToolEntrySchema` with `ops`. The
published JSON Schema is regenerated with `bun run gen:schema` (spec 26).

## Observability

- Spans: `connection.connect`, `connection.call` (instance, op, origin, task id
  if any), `connection.task`, `connection.event` (source, type, subscription).
- Framework events on `getFullStream()`: `connection_state_changed`,
  `connection_event_received`, `connection_task_updated`, `event_gap`,
  `subscription_terminated`.
- Model-facing tools stream task status as tool progress events.

## Errors

Setup and validation failures are `NoeticConfigError` codes (`09-error-model`),
raised by `harness.start()`, by slot checks before a run's root executes, or by
document validation:

| Code | When |
|---|---|
| `CONNECTION_TOOL_COLLISION` | Two operations map to the same model-facing tool name. |
| `CONNECTION_VERSION_UNSATISFIED` | A slot's profile or extension range excludes the bound instance's version. |
| `CONNECTION_EXTENSION_MISSING` | A slot requires an extension the bound instance does not offer. |
| `CONNECTION_OPERATION_UNSUPPORTED` | A slot's `ops`, or a step's operation, is not offered by the bound instance. |
| `CONNECTION_OPERATION_UNDECLARED` | A node or tool entry names an operation or event its slot did not declare. |
| `CONNECTION_PROFILE_MISMATCH` | A slot is bound to an instance marked unavailable for contradicting its declared profile. |
| `CONNECTION_ALLOWLIST_EXCEEDED` | A document's manifest asks for more than the host allowlist grants. |
| `UNKNOWN_CONNECTION_SLOT` | A node or tool entry names a slot the manifest does not declare. |
| `UNKNOWN_CONNECTION_INSTANCE` | A binding or subscription names an instance the harness does not have. |
| `INVALID_CONNECTION_REQUIREMENT` | A requirement is malformed: no profile or extension, a range that is not semver, `min` above `max`. |

Run-time failures are `NoeticError` kinds:

| Kind | Payload | When |
|---|---|---|
| `connection_unavailable` | `instance`, `reason` | The instance is disconnected, closed, or no longer satisfies its slots. |
| `connection_operation_failed` | `instance`, `op`, `error` (spec 36 § Operation errors) | The operation ran and failed. |
| `connection_reference_mismatch` | `instance`, `references` | A call's references name another instance than its `target`, or several instances. |
| `connection_reference_rejected` | `kind`, `instance` | A reference was not issued by this harness to this thread. |
| `connection_input_required` | `instance`, `taskId`, `inputRequests` | A task needs input and nothing can answer it. |
| `connection_binding_changed` | `slot`, `recorded`, `current` | A resumed run's binding no longer satisfies the recorded one. |
| `connection_subscription_terminated` | `subscription`, `reason` | The upstream ended a subscription a step was waiting on. |
| `task_lost` | `instance`, `taskId` | The server no longer knows a recorded task. |
| `event_gap` | `subscription` | A subscription with `onGap: 'fail'` received a truncated batch. |

## Future Considerations

- Proposing the profile format and the v1 catalog upstream as an MCP extension
  through the Agents interest group and the Tasks and Events working group.
- Sharing one connection across several harnesses in the same process.
