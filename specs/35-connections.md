# 35 — Connections

> **Depends On:** `01-step-type` (Step), `08-runtime` (AgentHarness, ArtifactStore), `09-error-model` (NoeticError, NoeticConfigError), `10-observability` (Span), `11-context-layer-system` (ContextLayer), `23-durable-execution` / `23a-step-level-resume` (checkpoint, ledger), `26-json-workflow-runtime` (WorkflowDocument), `33-expressions` (Expression), `34-custom-items` (custom items), `36-connection-profiles` (Profile, Extension), `37-verification` (verify step, channels)
> **Exports:** `Connection`, `ConnectionProvider`, `ConnectionManifest`, `ConnectionIdentity`, `ConnectionEvent`, `ConnectionReference`, `BlobReference`, `SecretReference`, `ConnectionSubscription`, `WebhookReceiver`, `connection()`, `connectionTools()`, `connectionObservations()`, `defineTrigger()`, `cronTrigger()`, `createInMemoryConnection()`, `step.connectionCall`, `step.acquireConnection`, `step.releaseConnection`, `step.subscribeEvents`, `step.awaitEvent`, `step.awaitTask`, `createWebhookReceiver()` (`@noetic-tools/platform-node`), `mcpConnection()` (`@noetic-tools/mcp`)

---

A **connection** is a live surface the agent acts on and hears from: an iOS
simulator, an Android emulator, a browser context, a desktop app, a Slack
workspace, a Teams tenant, a deploy pipeline. A harness holds any number of
them — some configured by name, some provisioned on demand from a pool for one
run, one parallel path or one call. Each offers **operations** (things to do),
**resources** (state to observe), **tasks** (operations that outlive a call)
and **events** (things that happened), described by the versioned **profiles**
and **extensions** of `36-connection-profiles`. What the agent sees through
them can be turned into evidence and verdicts by `37-verification`.

Connections are reached over the Model Context Protocol: tools for operations,
resources for observations, the
[Tasks extension](https://modelcontextprotocol.io/seps/2663-tasks-extension)
(`io.modelcontextprotocol/tasks`, SEP-2663) for long-running work, and the
[Events extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415)
(`io.modelcontextprotocol/events`, SEP-3415) for events. Anything that speaks a
profile plugs in, from any vendor, in any language. A connection can also be
implemented in-process — for tests, and for **triggers**, the programmatic event
sources a harness owns — and behaves identically.

## Connections are not platform adapters

The harness takes five typed adapters (`08-runtime`): `fs`, `shell`,
`subprocess`, `storage` and `artifacts`. The runtime itself depends on them —
context layers persist through `storage`, `runCode` dispatches through
`subprocess`, the ledger stores binary outputs through `artifacts` — so they
must be in-process, fast enough for the interpreter, and present in every
harness. Connections are the opposite: the runtime never depends on one, a
harness may have none, and each one is something the *agent* operates, not
something the *runtime* is built on.

The test for a new surface: if a context layer or the interpreter must call it,
it is an adapter; if a model, a step or a workflow calls it, it is a
connection. The two compose: a dev server started through a `SubprocessAdapter`
handle is an adapter concern, and the browser context provisioned against its
URL is a connection.

## Packages

```
@noetic-tools/core ─────────────→ @noetic-tools/types   (connection contract, profile format)
@noetic-tools/mcp ──────────────→ @noetic-tools/types   (+ MCP SDK)
@noetic-tools/agent-plugins ────→ @noetic-tools/mcp, @noetic-tools/types
@noetic-tools/profile-ui ───────→ @noetic-tools/types
@noetic-tools/profile-screen ───→ @noetic-tools/types
@noetic-tools/profile-browser ──→ @noetic-tools/profile-ui, @noetic-tools/types
@noetic-tools/profile-app ──────→ @noetic-tools/profile-ui, @noetic-tools/types
@noetic-tools/profile-device ───→ @noetic-tools/profile-ui, @noetic-tools/types
@noetic-tools/profile-chat ─────→ @noetic-tools/types
@noetic-tools/profile-conformance → @noetic-tools/mcp, @noetic-tools/types
@noetic-tools/verify ───────────→ @noetic-tools/types   (+ open-verification)   (spec 37)
@noetic-tools/platform-node ────→ @noetic-tools/core    (webhook receiver, file artifact store)
```

- **`@noetic-tools/types`** owns the contract: `Connection`,
  `ConnectionProvider`, identity, the event envelope, references, blob and
  secret references, `WebhookReceiver`, `ArtifactStore`, and the profile format
  (`defineProfile`, `defineExtension`, spec 36).
- **`@noetic-tools/core`** owns the harness integration: the connection
  registry, instance lifecycle and pools, model tools, observation layers,
  subscriptions, triggers, the step variants, the JSON nodes and durability.
- **`@noetic-tools/mcp`** is the MCP bridge: `mcpConnection()` turns an MCP
  server into a `ConnectionProvider`. It owns the MCP client, transports
  (stdio, Streamable HTTP, SSE), capability discovery, the Tasks and Events
  clients, Standard Webhooks verification, and the mapping of MCP binary
  content into the artifact store. It is the only package that imports the MCP
  SDK; `@noetic-tools/agent-plugins` reaches MCP servers through it.
- **`@noetic-tools/profile-*`** each publish one profile (spec 36): its
  schemas, its TypeScript types and its conformance scenarios.
- **`@noetic-tools/profile-conformance`** runs a profile's conformance
  scenarios against any server.
- **`@noetic-tools/verify`** implements verification over connections
  (spec 37).
- **`@noetic-tools/platform-node`** provides `createWebhookReceiver()` and
  `createFileArtifactStore()`.

### Core decoupling invariant

`@noetic-tools/core` imports only contract types from `@noetic-tools/types`. It
never imports `@noetic-tools/mcp`, the MCP SDK, `@noetic-tools/verify`, or any
profile package; it receives providers from configuration, profile objects from
the caller, and a verifier from the harness's registry. Profile packages never
import `@noetic-tools/mcp`. Only `@noetic-tools/mcp` imports the MCP SDK, and
only `@noetic-tools/verify` imports `open-verification`. All of these are
enforced by `.sentrux/rules.toml` boundaries, which also give each new package
a layer.

## Terms

| Term | Meaning |
|---|---|
| **Profile** | A versioned vocabulary of operations, resources and events, e.g. `browser@1.2.0` (spec 36). |
| **Extension** | A vendor's versioned addition, identified by reverse domain, e.g. `com.slack.blocks@3.0.0`. |
| **Connection** | A live instance: configured under a name the harness author chooses (`ios`, `slack`), or provisioned from a pool (`browsers/7f3a`). |
| **Provider** | What creates connections: it opens configured instances and, if it can, provisions new ones on demand. |
| **Pool** | A configured provider the harness provisions instances from, with limits and a queue. |
| **Lease** | One provisioned instance held by one scope — a run, a parallel path, or a call — and released when the scope ends. |
| **Identity** | OVP's subject `{ surface, instance, epoch? }`: the kind of place, what dies when the thing is replaced, and the round of edits it is carrying. |
| **Slot** | A workflow's own name for a connection it needs; bound to a configured instance or to a lease. |
| **Operation** | A named call: `ui.tap`, `chat.reply`, `com.acme.ios-permissions.grant`. |
| **Receipt** | What an operation with effects returns: that it was dispatched, an `actionId`, and the event cursor at dispatch. Never whether it worked. |
| **Event type** | A named occurrence with an arguments schema and a payload schema: `chat.message.created`. |
| **Subscription** | Interest in one event type with fixed arguments: step-scoped and in memory, or durable at the harness. |
| **Reference** | An id a connection hands out (a thread, an element, a task), carried with the instance that issued it. |
| **Blob reference** | A pointer to binary content in the artifact store: a screenshot, a recording, a trace, a download. |
| **Trigger** | An in-process event source defined with `defineTrigger()`; a connection that offers only events. |

## The contract

```ts
interface ConnectionProvider {
  /** Opens every instance configured for this provider. */
  connect(opts: ConnectionConnectOptions): Promise<ReadonlyArray<Connection>>;
  /** Present when the provider can create instances on demand. */
  provision?(request: ProvisionRequest, opts: ConnectionConnectOptions): Promise<Connection>;
  /** Fires when the set of instances the provider offers changes. */
  onInstancesChanged?(listener: () => void): () => void;
}

interface ProvisionRequest {
  /** Validated against the provider's declared provisioning schema, e.g. { url, storageState, viewport }. */
  spec: Record<string, unknown>;
  signal: AbortSignal;
}

interface ConnectionConnectOptions {
  signal: AbortSignal;
  storage: ScopedStorage;           // provider-private, e.g. webhook secrets
  artifacts: ArtifactStore;         // where binary results go
  webhooks?: WebhookReceiver;       // present when the harness can receive webhooks
}

interface Connection {
  readonly instanceId: string;
  readonly manifest: ConnectionManifest;
  /** Current identity; changes when the instance is replaced (new instance) or edited (new epoch). */
  readonly identity: ConnectionIdentity;
  onIdentityChanged(listener: (identity: ConnectionIdentity) => void): () => void;
  onManifestChanged(listener: (manifest: ConnectionManifest) => void): () => void;
  call(op: string, args: unknown, opts: ConnectionCallOptions): Promise<ConnectionCallResult>;
  readResource(uri: string, opts: { signal: AbortSignal }): Promise<ConnectionResource>;
  readonly tasks: ConnectionTasks;
  readonly events: ConnectionEvents;
  /** Returns the instance to a known start, when its determinism profile offers a reset. */
  reset?(opts: { signal: AbortSignal }): Promise<void>;
  /** Resolves when the instance becomes unavailable; carries the reason. */
  readonly closed: Promise<ConnectionClosed>;
  /** Closes a configured instance, or ends a provisioned one and frees its slot in the pool. */
  release(): Promise<void>;
}

/** OVP's SubjectRef. */
interface ConnectionIdentity {
  /** One of OVP's named surfaces ('web', 'desktop', 'mobile', 'service', …) or an `x-` surface. */
  surface: string;
  /** Changes whenever the thing it names is replaced. Never constant (OVP-SUBJ-1). */
  instance: string;
  /** The round of source edits, a non-negative integer; absent when edits cannot be observed. Absent is not zero. */
  epoch?: number;
}

interface ConnectionCallOptions {
  signal: AbortSignal;
  /** Deterministic per logical call (§ Durability). */
  idempotencyKey: string;
}

type ConnectionCallResult =
  | { kind: 'complete'; value: unknown }
  | { kind: 'task'; taskId: string; pollIntervalMs?: number };

interface ConnectionTasks {
  get(taskId: string): Promise<ConnectionTaskState>;
  update(taskId: string, inputResponses: Record<string, unknown>): Promise<ConnectionTaskState>;
  cancel(taskId: string): Promise<void>;
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
  arguments: Record<string, unknown>;
  /** `null` starts from now. */
  cursor: string | null;
  signal: AbortSignal;
}

interface ConnectionEventStream extends AsyncIterable<ConnectionEventBatch> {
  /** Resolves once the subscription is established upstream and its start cursor is known. */
  readonly ready: Promise<{ cursor: string | null }>;
  readonly terminated: Promise<{ reason: string }>;
  close(): Promise<void>;
}

interface ConnectionEventBatch {
  events: ConnectionEvent[];
  cursor: string | null;
  truncated: boolean;
}
```

`@noetic-tools/core` ships `createInMemoryConnection()` and
`createInMemoryPool()`, scripted implementations of the full contract
(operations as functions, events pushed by the test, tasks settled by the test,
identity changed by the test), so every behavior in this spec is testable
without MCP.

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
  /** Identity of the source when the event was observed, stamped by the harness. */
  identity: ConnectionIdentity;
  /** The action this event is attributed to, when the server attributes it. */
  actionId?: string;
}
```

It is SEP-3415's event occurrence with its fields renamed to match Noetic's
item vocabulary, plus `source`, `identity` and `actionId`. Payload fields an
extension adds sit under `payload.ext["<extension id>"]` (spec 36).

## Binary content

Screenshots, recordings, traces, downloads and other binary results never
travel inline through workflow data, the ledger, traces or expressions. The
MCP bridge writes every MCP `image`, `audio` and embedded binary `resource`
content block, and every `resource_link` the operation's schema marks as an
artifact, to the harness's `ArtifactStore` (`08-runtime` § Artifact Store), and
replaces it with a reference:

```ts
interface BlobReference {
  $blob: { uri: string; mimeType: string; bytes: number; sha256: string };
}
```

- **Everywhere data flows, blobs are references.** Step outputs, ledger
  entries, checkpoints, JSON workflow data and spans carry the reference only,
  so a run's ledger entries stay far below the `23a` size cap and a resumed run
  sees the same bytes it saw before, by hash.
- **The model sees content, within budget.** Observation layers and tool
  results resolve blob references to image or audio content when they render,
  subject to the observation policy's `maxImages` (§ Observations). A blob over
  the provider's size limit is rendered as its metadata.
- **Blob references are scoped like durable references.** A blob reference is
  valid as an argument only within the provenance scope that produced it
  (§ References). A document may not contain a `$blob` literal unless the host
  allowlist names it. Sensitive blobs — a stored session, a fixture — are never
  rendered to the model and may be passed only to `sensitive` fields.
- **Every run has an artifact manifest.** The harness records each blob a run
  produced or consumed, with the step and connection it came from, retrievable
  through `harness.getRunArtifacts(executionId)` and attached to the run's
  trace and to its verification run (spec 37). Retention follows the artifact
  store's per-run caps; a blob dropped by retention is reported, never silently
  missing.

## Secrets

An argument value may be a secret reference instead of a literal:

```json
{ "kind": "connectionCall", "id": "login", "connection": "app", "op": "ui.fill",
  "args": { "element": { "expr": "password" }, "text": { "$secret": "app.password" } } }
```

- A `$secret` value may fill only a field its operation marks `sensitive`
  (spec 36); anywhere else the call is refused before dispatch. A secret cannot
  be sent as a URL, a message body or an evaluated expression.
- The harness resolves `{ "$secret": name }` through its `secrets` resolver
  (`environment.secrets`, `08-runtime`) at dispatch, **after** the gate chain
  and immediately before the call reaches the connection. The value is never
  written to the ledger, a span, a checkpoint, an idempotency comparison or the
  model's context, and never returned in an error.
- **Scrubbing.** Before any output, event, observation or text artifact is
  persisted, traced or shown to the model, the harness replaces every resolved
  secret value in it — and its URL-encoded and base64 forms — with
  `"<redacted>"`, and verification records a `redacted` blind spot (spec 37).
  Pixels cannot be scrubbed; servers render sensitive fields masked, and
  conformance checks that they do.
- A profile may mark an input field `sensitive` (spec 36). Literal values in
  sensitive fields are redacted to `"<redacted>"` everywhere the harness
  persists or reports them, and the idempotency comparison uses a keyed hash of
  them. A verification run records a redacted field as a `redacted` blind spot
  (spec 37).
- A model cannot produce a secret reference: model tool arguments containing
  `$secret` are rejected with `connection_secret_not_allowed`. Only steps and
  documents may name secrets. The host allowlist (§ Host allowlist) binds each
  secret a document may use to an instance or pool, an operation and a field.

## Harness configuration

```ts
const harness = new AgentHarness({
  environment: {
    connections: {
      ios:      iosSimulator,
      android:  { provider: emulators, instance: 'Pixel_8_API_35' },
      slack:    { provider: mcpConnection({ url: 'https://slack-mcp.example.com/mcp' }),
                  policy: { approve: ['chat.post'], deny: ['com.slack.admin.*'] } },
      deploys:  deployTrigger,
    },
    pools: {
      browsers: { provider: mcpConnection({ command: 'playwright-mcp', args: [] }),
                  max: 8, queueTimeout: 6e4, idle: 2 },
    },
    artifacts: createFileArtifactStore({ dir: '.noetic/artifacts' }),
    secrets: (name) => process.env[`NOETIC_SECRET_${name.toUpperCase().replaceAll('.', '_')}`],
    webhooks: createWebhookReceiver({ port: 8787, publicUrl: 'https://agent.example.com' }),
  },
});
await harness.start();
```

- **Configured names are the harness author's.** Every surface below — tool
  targets, event `source`, storage keys, policy, references — uses the
  configured name, never the provider's `instanceId`. Provisioned instances are
  named `<pool>/<lease id>`.
- **Start.** Construction is synchronous and only validates configuration.
  `harness.start()` — called implicitly by the first `execute()` or `run()` —
  connects every configured provider, negotiates each instance
  (§ Negotiation), warms each pool to its `idle` count, builds the model tool
  pool, starts triggers and harness subscriptions, and checks the harness's own
  `agentGraph` slots. Setup failures surface here as `NoeticConfigError`s.
- **Unavailable instances.** An instance whose `closed` resolves is marked
  unavailable: its tools return a tool error naming it, its steps fail with
  `connection_unavailable`, its subscriptions pause with their cursors kept,
  and every other instance keeps working. A configured instance reconnects with
  backoff; a provisioned one is replaced on its next acquisition.
- **Manifest changes.** When an instance's manifest changes, the harness
  renegotiates it. If it still satisfies every slot bound to it, the tool pool
  is rebuilt and takes effect at the next turn, never mid-turn. If it no longer
  does, the instance is marked unavailable with reason `manifest_unsatisfied`.
- **Renaming is a new connection.** Durable state is keyed by name; a renamed
  instance starts with no cursors, inbox, tasks or references.

## Pools and leases

A pool provisions instances on demand from a provider that implements
`provision`. It exists because many workloads — a test suite, a verification
run, parallel exploration — need fresh, isolated instances that live exactly as
long as the work using them.

- **Limits.** `max` bounds live instances. An acquisition over the limit waits
  in a FIFO queue until an instance is released or `queueTimeout` passes, then
  fails with `connection_pool_exhausted`. `idle` keeps that many pre-provisioned
  instances ready.
- **Leases are scoped.** A lease belongs to a run, a parallel path or a single
  call, and is released when that scope ends — completed, failed or aborted.
- **Leases outlive a crash briefly.** The harness holding a lease renews it
  every `heartbeatMs` (default 15 s). A lease not renewed for `leaseTtlMs`
  (default 120 s) is reclaimed. A harness that restarts and resumes the owning
  execution within the TTL reattaches to the same lease and identity; after it,
  the lease is gone and resume proceeds as against a replaced instance
  (§ Durability).
- **Exclusive by default.** A lease is used only by the scope that holds it, so
  two parallel paths never drive one browser context. `exclusive: false` lets a
  scope's children share it.
- **Provisioning spec.** A pool's provider declares a provisioning schema (spec
  36 § Provisioning); `acquireConnection` and slot bindings pass a `spec`
  validated against it — a start URL, a stored session, a viewport, a device
  model. Fields the schema marks `hostOnly` — an app's `path`, `command` and
  `env` — are taken only from the pool's own configuration
  (`pools.apps.spec`); a workflow that sets one is refused. The host allowlist
  can further restrict the fields a document may set (§ Host allowlist).
- **Identity.** Each provisioned instance has its own identity. A replaced
  instance is a new identity, never a reused one.

Slots bind to leases declaratively (§ Steps, § JSON workflows), or a workflow
acquires them explicitly with `acquireConnection`.

## Connection registry

Steps, tools and hydrated workflows never hold a provider's `Connection`
object. They resolve instances — configured or leased — by name through the
harness's **connection registry** (`ctx.connections`) at the moment they
execute. The registry wraps each live connection with everything the harness
owns: alias projections (spec 36 § Wire declaration, evaluated here under fixed
expression limits and validated per call), identity tracking, reference wrapping and checking, blob storage, secret
resolution, the gate chain, unavailability, reconnection and renegotiation, and
lease scoping. No code path can call a server around the harness.

## Negotiation and versions

An MCP server declares what it implements under the `tools.noetic/profiles`
key of its `extensions` capability (spec 36 § Wire declaration): profile and
extension versions, per-instance overrides, the alias map, determinism,
channels and the provisioning schema. `mcpConnection()` reads the declaration
during capability discovery and validates the server's tools and event types
against the declared profile schemas, through the alias map. An instance whose
tools contradict its declared profile is marked unavailable with reason
`profile_mismatch`.

Requirements — from a `connection()` slot in TypeScript or a document's
`connections` manifest — are semver ranges per profile and per extension, plus
the optional operations a slot calls and the channels it must observe:

```ts
connection('app', {
  profile: browser.range('^1.2'),
  ops: ['browser.network.list'],      // optional profile parts this slot calls
  observes: ['net', 'log', 'ui'],     // OVP channels it needs to see (spec 37)
});
```

A profile range implies its parents' ranges (spec 36 § Inheritance). An
unsatisfied requirement fails with `CONNECTION_VERSION_UNSATISFIED`, a missing
extension with `CONNECTION_EXTENSION_MISSING`, a missing optional operation with
`CONNECTION_OPERATION_UNSUPPORTED`, and a channel the instance does not declare
with `CONNECTION_OBSERVATION_UNSUPPORTED`, each naming the slot, the instance,
the requirement and what the instance offers. For pooled slots the check runs
against the pool's declaration before anything is provisioned.

## The gate chain

Every connection call — from the model, from a step, from a JSON node — passes
through the same gates `invokeTool` does (`08-runtime` § Tool approval), in
order:

1. **Declaration.** The operation is in the instance's manifest and, for steps
   and nodes, declared by the slot.
2. **Validation.** `args` against the operation's input schema. Malformed
   arguments are refused; the harness never substitutes a default.
3. **References.** Every reference in `args` is valid (§ References); the call
   is routed to the instance it names.
4. **Instance policy.** `allow` / `deny` / `approve` globs over operation
   names, evaluated against the instance the call is routed to. Operations a
   profile marks `guarded` (spec 36) require approval unless the policy
   explicitly allows them. A server's per-target `guarded` refusal also goes
   to approval; once approved, the harness retries with
   `_meta["tools.noetic/confirmed"]`, which only the harness can set.
5. **`beforeToolCall` layers** and the **harness approver**, with the instance,
   its identity, the operation and the call origin (`model`, `step`,
   `workflow`) in the call metadata.
6. **Secrets** resolve (§ Secrets), and the call is dispatched.

A refusal throws `steering_denied` for steps and returns a tool error to the
model. Author-written steps are gated like everything else, so a policy holds
whatever path a call takes.

## Model-facing tools

How an instance's operations reach the model is set per instance with
`expose`:

| `expose` | Tools |
|---|---|
| `'core'` (default) | The operations its profiles mark `core`, plus a lazy pair for the rest. |
| `'all'` | Every operation as a tool. |
| `'lazy'` | Only the lazy pair. |
| `'profiles'` | Profile operations only, no extensions. |
| `'none'` | Nothing; the instance is for steps and observation only. |

**The lazy pair.** `<instance>_tools` lists the instance's remaining
operations with their descriptions and input schemas, filtered by an optional
query; `<instance>_run({ op, args })` calls one. Calls through the pair pass
the full gate chain. This keeps a large surface out of every turn's tool
schemas: the model pays for an operation's schema only when it asks for it.

**Shared tools across instances.** Operations are grouped by the profile major
that defines them. When two or more instances offer the same operation of the
same profile major, the harness exposes one tool with a required `target`
argument naming the instance. `target` is validated at call time against the
instances the calling scope can reach — configured instances plus the leases
it holds — so a lease acquired mid-turn is a valid target at once. The schema's
description lists the reachable instances when the turn starts. With a single
reachable instance, `target` is optional. The shared tool's input schema is the
operation's schema at the lowest profile minor among its targets, plus an
optional `ext` object keyed by extension id, validated against the chosen
target's extensions (spec 36 § Adding fields).

**Extension operations** are named for their instance:
`ios__com_acme_ios-permissions_grant`. **Tool names** map `.` to `_`, with
`__` separating an instance prefix and the profile major included when
instances run different majors (`chat_v2_reply`). A collision fails
`harness.start()` with `CONNECTION_TOOL_COLLISION`.

**Selection per call.** A `callModel` step narrows what it offers with
`connectionTools(slot, { ops, expose })`. The tools resolve through the
registry when the step runs. The JSON form is a tool entry
`{ "type": "connection:<slot>", "ops": [...], "expose": "core" }`.

## Observations

Each exposed instance gets a context layer, `connectionObservations(name)`,
with its own budget. What it reads, and when, is an **observation policy** per
resource:

```ts
observe: {
  'browser.page.summary': { mode: 'every-turn' },
  'ui.tree':              { mode: 'after-effect', detail: 'summary' },
  'screen.current':       { mode: 'on-demand', maxImages: 1 },
}
```

| `mode` | Read when |
|---|---|
| `every-turn` | Every `recall`. For cheap summaries only. |
| `on-change` | After a `resources/updated` notification, else not at all. |
| `after-effect` | After an operation with effects on that instance, once its settle (or its receipt) returns. |
| `on-demand` | Only when the model asks, through `<instance>_observe({ resource, detail })`. |

- `detail` selects the profile's `summary` or `full` rendering of a resource.
  `maxImages` caps images the layer renders per turn across the instance.
- Repeated reads render as a diff against the last rendering the model saw,
  when the resource's schema supports it.
- Profiles declare each resource's default policy (spec 36). Every UI profile
  requires a cheap summary resource and makes images `on-demand` by default, so
  a harness driving a browser pays tens of tokens per turn for perception, not
  a screenshot and a full tree.
- Every read reports its token cost in the layer's state, so a policy can be
  tuned from traces.

## References

Operations, events and tasks return ids that only mean something on the
instance that issued them. A profile marks those fields as references, with a
lifetime (spec 36 § References); the harness wraps each one on the way in:

```ts
interface ConnectionReference {
  $ref: { instance: string; kind: string; id: string; lifetime: 'durable' | 'volatile'; subject?: string; kid?: string; sig?: string };
}
```

- **Routing.** A call is routed to the instance its references name. A `target`
  that contradicts a reference fails with `connection_reference_mismatch`, as
  do references to two instances in one call.
- **Durable references** (a thread, a message, a task, an installed app) are
  recorded per **provenance scope** in the harness `StorageAdapter`, bounded per
  scope (`referenceRetention`, default 1e4, least recently used dropped). A
  reference in `args` that the harness did not issue in the same scope is
  rejected with `connection_reference_rejected`.
- **Volatile references** (an element in a UI tree, a window, a tab's frame)
  are never stored. The harness signs them: `subject` is the instance's OVP
  `instance` value when the reference was issued, and `sig` is an HMAC over the
  reference and `subject` under a signing key identified by `kid`. Keys live in
  the harness `StorageAdapter`, so a restarted harness verifies references it
  issued before; rotation adds a key and keeps old ones for verification until
  `referenceKeyTtl` passes. A volatile reference whose `subject` is not the
  instance's current `instance` is refused with `connection_reference_stale`
  before the call is sent; an epoch change alone does not invalidate it. A
  server that finds the element gone returns the `stale_reference` operation
  error.
- **Provenance scope** is the session thread. A spawned child and every
  parallel path share their parent's scope, so references flow freely between
  a workflow's steps and its children. A lease's references belong to the
  lease's scope and become stale when it is released.
- References whose kind a profile marks `public` (a channel id, a URL) skip
  the provenance check but are still routed and gated.
- References survive serialization, checkpoints and JSON workflow data
  unchanged.

## Receipts and settling

An operation with effects returns a **receipt** in its result (spec 36 §
Receipts):

```ts
interface Receipt { actionId: string; cursor: string | null; dispatched: true }
```

A receipt says the action was delivered and where the instance's event streams
stood at that moment. It never says the action worked — that is a question for
observation (§ Events) and verification (spec 37). Events a server attributes
to the action carry its `actionId`, and subscriptions can filter on it.

UI profiles define a settle operation (`ui.settle`, spec 36) that waits until
the instance is quiet or a named signal arrives, or a budget runs out, and
returns which one closed it as an OVP close condition (`quiescence`, `signal`,
`budget-exhausted`) — the values verification windows use (spec 37).

## Tasks

Task creation is server-directed (SEP-2663). The bridge declares
`io.modelcontextprotocol/tasks` in its per-request client capabilities on every
`tools/call`, so any operation may return a task; a profile's `task` field
(spec 36) only states what a conforming server must do. A call that returns a
task yields a reference of kind `task`.

- **Waiting.** By default a `connectionCall` waits for the task and returns its
  result, following `watch` when offered or polling `tasks/get` at the server's
  `pollIntervalMs`. The model-facing tool streams task status as tool progress.
- **Starting.** `connectionCall` with `await: false` returns the task reference
  at once; `awaitTask` waits for it later.
- **Input required.** A task in `input_required` carries `inputRequests`
  (SEP-2322). An elicitation request goes to the approval channel as a question
  for a person, and its answer returns through `tasks/update`; a sampling
  request runs on the harness's model provider. With nothing to answer, or with
  `onInput: 'fail'`, the step fails with `connection_input_required`.
- **Cancellation.** Aborting the step, the turn or the harness cancels the task
  through `tasks/cancel`, unless the call set `detach: true`.

## Durability

### Idempotency

Each logical call has a deterministic **idempotency key**: the execution id
plus the step's ledger key (`23a-step-level-resume` § Identity), or the turn id
plus the tool call id for model calls. The bridge sends it as
`_meta["tools.noetic/idempotency-key"]`. Each operation declares whether its
server must honor it (spec 36 § Idempotency):

- **`idempotency: 'required'`** — operations with lasting upstream effects
  (posting a message, installing an app, starting a test run). A repeated key
  returns the original outcome without repeating the effect.
- **`idempotency: 'none'`** — operations whose effect is local to the
  instance's current state (a tap, typing, a navigation). Their safety on
  resume comes from the instance's determinism profile, not from deduplication.

### Pre-dispatch entries

A `connectionCall`, `acquireConnection`, `subscribeEvents`, `awaitEvent` or
`awaitTask` step writes a **pre-dispatch ledger entry** before it reaches the
server: the idempotency key, the instance and its identity, and as they become
known the task reference, the lease, the subscription with its start cursor,
and the deadline. Completion records the result as for any step, with blobs as
references.

### Resume against a changed instance

On resume, each instance a run used is compared with the identity its entries
recorded:

- **Same identity.** Steps with a completion entry replay from the ledger.
  Steps with only a pre-dispatch entry reattach: they re-send the call with the
  same key, wait on the recorded task, or resubscribe from the recorded cursor,
  until the recorded deadline.
- **Changed identity** — the browser restarted, the lease was lost, the
  simulator was reset. Replaying recorded results would continue against a
  world that no longer exists. The instance's **determinism profile** (spec 36
  § Determinism, after OVP §10.4) decides, through OVP's `resumeStrategy`:

| `replayPrefix` | Strategy | What resume does |
|---|---|---|
| `free` | `replay-prefix` | Discards the ledger from the first step that used the instance and runs live from there. |
| `costly`, with a reset | `reset-then-replay` | Calls `reset`, re-applies the slot's fixture if any, then runs live from that step as above. |
| `costly`, no reset | `replay-prefix` | As `free`. |
| `unsafe` | `refuse` | Fails with `connection_instance_replaced` and requires an explicit `harness.resume(executionId, { reexecute: [instance] })`. |

  `unsafe` is checked first and alone. Discarding the ledger suffix is the
  honest form of OVP's replay-prefix inside a step ledger (`23a`): the earlier
  steps on the instance run again for real, and so does everything after them,
  model rounds included, because their inputs were derived from the old
  instance. Re-run `idempotency: 'required'` calls still carry their original
  keys, so a conforming server returns their original outcomes. Volatile
  references from the old instance are stale; the re-run steps mint new
  ones.
- **Changed epoch only** (a hot update) keeps the instance and its references.
  Steps continue; verification records `evidence-predates-edit` for evidence
  gathered before the edit (spec 37), and an `identity_changed` framework event
  lets a workflow react.

A binding that no longer satisfies the recorded requirement fails with
`connection_binding_changed`. Task references share the reattach mechanics of
`SubprocessAdapter` handles (`23-durable-execution`) but are their own type.

## Events

Events reach the harness in three delivery modes, all defined by SEP-3415:

| Mode | Wire | When the bridge uses it |
|---|---|---|
| Push | `events/stream` | The server supports it and the transport keeps a connection open. |
| Webhook | `events/subscribe` with a callback URL | The server supports it and the harness has a `WebhookReceiver`. |
| Poll | `events/poll` | Fallback, at the server's interval hint, default 30 s. |

The connection chooses the mode per subscription, preferring push, then
webhook, then poll. Heartbeat cursors advance stored cursors even when no
events match. Each event type declares its replay (spec 36): `durable` (cursors
survive server restarts), `session` (cursors valid for the current instance
identity, in a bounded buffer the server keeps) or `none`.

### Webhook receiver

```ts
interface WebhookReceiver {
  register(registration: WebhookRegistration): Promise<WebhookEndpoint>;
  unregister(endpointId: string): Promise<void>;
}
```

`@noetic-tools/platform-node`'s `createWebhookReceiver()` serves the endpoints
over HTTP; a serverless host implements the same interface. The bridge
registers one endpoint per subscription, keeps a per-subscription secret in
provider storage, and for each delivery verifies the Standard Webhooks
signature, rejects a `webhook-timestamp` more than five minutes from now, drops
a `webhook-id` it has already accepted, dispatches `terminated` and `gap`
control envelopes, and refreshes the subscription before its TTL lapses.

### Two kinds of subscription

| | Step-scoped | Harness |
|---|---|---|
| Created by | `subscribeEvents`, `awaitEvent`, `ui.settle`, verification windows | `subscriptions` configuration, JSON `subscriptions` |
| Lifetime | The step or scope that opened it | The harness |
| Storage | In memory, bounded | Durable inbox in the `StorageAdapter` |
| Purpose | Observation: what happened around an action | Triggering: what starts or joins a turn |

Both deduplicate per subscription on the event `id`, as SEP-3415 scopes it.
Both report gaps (`truncated` batches, overflow) as an `event_gap` framework
event, and both handle termination (`notifications/events/terminated`, a
`terminated` webhook envelope, a poll answered `Forbidden` or `NotFound`) by
emitting `subscription_terminated`.

### Step-scoped subscriptions

A step-scoped subscription buffers from the moment it is `ready` until the
scope that opened it ends, so nothing between subscribing and waiting is lost.

- **Bounds.** `maxBuffered` (default 1e4 events) caps the buffer. On overflow
  the oldest events are dropped and the subscription records a gap, which
  verification reports as a `buffer-truncated` blind spot. A gap is never
  silent.
- **Shaping.** `debounceMs` delivers only the last event of a burst;
  `coalesce: (a, b) => …` merges a burst into one; `filter` drops events
  before they count against the buffer; `actionId` keeps only events attributed
  to one action. High-volume channels — console, network, DOM mutations — are
  observed this way, never through the durable inbox.
- **Durability.** The start cursor is recorded in the pre-dispatch entry. On
  resume against the same identity a replayable subscription resubscribes from
  it; a `none` subscription records a gap for the downtime. Against a changed
  identity the subscription is reopened by the resume strategy.

### Harness subscriptions

Harness subscriptions declare which events start or join a turn.

```ts
new AgentHarness({
  subscriptions: [
    {
      id: 'slack-mentions',
      source: 'slack',
      event: 'chat.message.created',
      arguments: { mentionsAgent: true },
      filter: (e) => !e.payload.author.isBot,
      session: (e) => `slack:${e.payload.thread.$ref.id}`,
      input: (e) => e.payload.text,
      deliveryMode: 'next-turn',
      maxPending: 100,
    },
  ],
});
```

Delivery is durable end to end:

1. Events passing `filter` are written to the subscription's **inbox**
   (`connections/<instance>/subscriptions/<id>/inbox`) and the cursor advances,
   in one `StorageAdapter` write batch.
2. Each inbox entry is delivered as `harness.execute(input(event), { threadId:
   session(event), deliveryMode, messageId })` with `messageId` set to
   `<instance>:<subscription id>:<event id>`, and the event attached to the turn
   as a `noetic:connection_event` custom item (`34-custom-items`).
3. The entry is marked done when its turn completes, and the subscription's
   processed set records its id (`processedRetention`, default 1e3). On restart,
   entries not marked done are delivered again; an id in the processed set is
   never delivered again.

`maxPending` bounds undelivered inbox entries per subscription; past it, new
events are dropped with an `event_gap`, and `debounceMs` and `coalesce` apply
as for step-scoped subscriptions. For a `durable` event type this starts each
matching event's turn exactly once across crashes and redeliveries.

## Triggers

A **trigger** is an event source the harness author defines in code: a cron, a
queue consumer, a file watcher, a deployment webhook, or host code calling in.
Triggers are connections that offer only events, so they get every behavior
above with nothing trigger-specific in the runtime.

```ts
const deployTrigger = defineTrigger({
  id: 'com.acme.deploys',
  version: '1.0.0',
  events: {
    'com.acme.deploys.finished': { payload: DeployFinishedSchema, replay: 'durable' },
    'com.acme.deploys.failed': { payload: DeployFailedSchema, arguments: DeployFilterSchema, replay: 'durable' },
  },
  async start({ emit, cursor, signal }) {
    for await (const msg of queue.consume({ after: cursor, signal })) {
      await emit({ type: 'com.acme.deploys.finished', id: msg.id, payload: msg.body, cursor: msg.offset });
    }
  },
});
```

- A trigger is a standalone extension (`com.acme.deploys@1.0.0`, spec 36), so
  its event types carry its id as a prefix. Workflows require it like any other
  extension.
- A subscription's `arguments` are applied as a filter before the inbox.
- `start` runs while the harness runs, restarts with backoff, and receives the
  last cursor stored for it. `emit` resolves after every subscription has
  accepted the event.
- `harness.emit(name, { type, id, payload })` delivers an event into a trigger
  from host code, validated against the trigger's schema.
- `cronTrigger({ id, schedule, timezone })` offers one event type, `<id>.tick`,
  whose event id is the scheduled time, so a missed tick is delivered once.

## Steps

```ts
import { connection, connectionTools, step } from '@noetic-tools/core';
import { browser } from '@noetic-tools/profile-browser';
import { chat } from '@noetic-tools/profile-chat';

const app  = connection('app',  { profile: browser.range('^1.2'), lease: { pool: 'browsers', scope: 'path', spec: { url: 'http://localhost:5173' } }, observes: ['net', 'log', 'ui'] });
const team = connection('team', { profile: chat.range('^1') });

const open    = step.connectionCall({ connection: app, op: 'ui.find', args: { query: 'button "Pay"' } });
const pay     = step.connectionCall({ connection: app, op: 'ui.tap', args: (input) => ({ element: input.elements[0].element }) });
const settled = step.connectionCall({ connection: app, op: 'ui.settle', args: (input) => ({ until: 'quiet', after: input.receipt, timeoutMs: 1e4 }) });

const extra   = step.acquireConnection({ pool: 'browsers', spec: { url: 'http://localhost:5173/admin' }, as: 'admin' });
const watch   = step.subscribeEvents({ connection: team, event: 'chat.message.created', arguments: (input) => ({ thread: input.thread }) });
const answer  = step.awaitEvent({ subscription: (input) => input.subscription, filter: (e) => /approve/i.test(e.payload.text), timeout: 18e5 });

const agent = step.callModel({ tools: [connectionTools(app, { expose: 'core' })], /* … */ });
```

- **Slots are declared, then bound.** `connection(slot, requirement)` declares
  a requirement. A slot binds to a configured instance — the same-named one, or
  as given in `bindings: { team: 'slack' }` — or to a **lease** with
  `lease: { pool, scope: 'run' | 'path' | 'call', spec, exclusive }`, acquired
  when the scope first uses the slot and released when it ends. Inside an
  `inParallel`, `scope: 'path'` gives each path its own instance.
- **Checks.** Slots in `agentGraph` are checked at `harness.start()`; a step
  tree produced at run time (`dynamicWorkflow`, `harness.run(child)`) is
  checked before its own root executes; and a connection step re-checks its
  operation against the live manifest when it runs, failing with
  `CONNECTION_OPERATION_UNSUPPORTED` rather than a server error.
- **Explicit leases.** `acquireConnection({ pool, spec, as })` provisions an
  instance for the current scope and returns a reference of kind `connection`;
  `as` names it for later steps in the scope. `releaseConnection` ends it
  early. Leases are released when their scope ends either way.
- **Operations are typed by the slot.** `op` is a union of the operations the
  slot's profile, its parents and its declared extensions define; `args` and
  the output are typed by that operation's schemas.
- **Step variants.** `connectionCall`, `acquireConnection`,
  `releaseConnection`, `subscribeEvents`, `awaitEvent` and `awaitTask` join the
  `Step` union, spelled the same in TypeScript and JSON. Each writes a
  pre-dispatch entry and records its result (§ Durability). Timeouts are
  milliseconds; deadlines are recorded.
- **Not missing an event.** `subscribeEvents` waits for `ready`, records the
  cursor and returns a reference to a step-scoped subscription. `awaitEvent`
  given that subscription matches events from the recorded cursor onward, so
  subscribe → act → await cannot miss the event the action causes.
  `awaitEvent` given `connection` and `event` subscribes itself and sees only
  later events. `actionId: (input) => input.receipt.actionId` narrows to events
  attributed to one action.
- **Several configured instances per slot.** A slot with `min`/`max` binds to
  the instances listed in `bindings` for it. `connectionCall` on such a slot
  takes `target` (an instance name, a function of the input, or `{ all: true }`,
  returning `[{ instance, result }]`).
- **Verification** wraps these steps: `step.verify` (spec 37) declares claims
  about one subject slot, runs an action inside a window over its observed
  channels and any witnesses, and adjudicates.

## JSON workflows

### The manifest

```json
{
  "version": 1,
  "connections": {
    "app":     { "profile": "browser@^1.2", "observes": ["net", "log", "ui"],
                 "lease": { "pool": "browsers", "scope": "path", "spec": { "url": { "expr": "previewUrl" } } } },
    "phone":   { "profile": "device@^1.2", "extensions": { "com.acme.ios-permissions": "^1.0" }, "ops": ["device.test.run"] },
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

- `connections` maps slot names to requirements: optional `profile`
  (`name@range`), `extensions` (id → range), `ops`, `observes`, `min`/`max`, and
  `lease` for pooled slots. A slot needs a profile, an extension or both. Every
  dependency carries a version range; a bare name is a validation error.
- `subscriptions` are harness subscriptions in JSON form, with expressions for
  `filter`, `session` and `input` evaluated against the event envelope. They
  are standing harness configuration: they take effect only when the document
  is given to the harness at construction as its graph, `parseAndRunWorkflow`
  ignores them unless called with `{ subscriptions: 'activate' }`, and a
  document produced by `dynamicWorkflow` that declares any fails validation.
- Configured slots bind through the registry by same name or by
  `HydrationContext.bindings`; a multi-instance slot must be bound explicitly.
  Pooled slots bind when their scope first uses them. Binding is checked before
  the root node executes.
- The resolved binding — instance or pool, provider, server name and version,
  identity, and the profile and extension versions that satisfied each slot —
  is recorded in the run's trace and checkpoint.

### Host allowlist

A document's manifest says what it needs; the host decides what it may have.
`parseAndRunWorkflow` and `dynamicWorkflow` take a `connections` allowlist, keyed
by instance name, pool name or glob (`'browsers'`, `'device-*'`), each with
operation globs, event globs and the secret names it may use:

```ts
dynamicWorkflow({
  connections: {
    browsers: { ops: ['ui.*', 'browser.*'], events: ['browser.*'],
                spec: { url: ['http://localhost:*', 'https://*.preview.example.com/*'] },
                secrets: { 'app.password': { op: 'ui.fill', field: 'text' } } },
    slack:    { ops: ['chat.reply'], events: ['chat.message.created'] },
  },
});
```

A manifest that asks for an instance, pool, operation, event, provisioning
value or secret outside the allowlist — or a secret in another operation or
field than it is bound to — fails validation with
`CONNECTION_ALLOWLIST_EXCEEDED`. `spec` entries are glob patterns per
provisioning field; fields not listed may not be set by the document. With no
allowlist a document may bind nothing. `dynamicWorkflow` describes only the
allowlisted instances, pools and operations to the model. Instance policy and
the gate chain still apply to every call.

### Nodes

```json
{ "kind": "connectionCall", "id": "find", "connection": "app", "op": "ui.find",
  "args": { "query": "button \"Pay\"" } }

{ "kind": "connectionCall", "id": "pay", "connection": "app", "op": "ui.tap",
  "args": { "element": { "expr": "elements[0].element" } } }

{ "kind": "acquireConnection", "id": "admin", "pool": "browsers", "as": "admin",
  "spec": { "url": "http://localhost:5173/admin" } }

{ "kind": "connectionCall", "id": "run", "connection": "phone", "op": "device.test.run",
  "args": { "plan": "smoke" }, "await": false }

{ "kind": "awaitTask", "id": "done", "connection": "phone", "task": { "expr": "task" }, "timeout": 1200000 }

{ "kind": "subscribeEvents", "id": "watch", "connection": "chats", "target": { "expr": "thread.$ref.instance" },
  "event": "chat.message.created", "arguments": { "thread": { "expr": "thread" } } }

{ "kind": "awaitEvent", "id": "approval", "subscription": { "expr": "subscription" },
  "filter": { "expr": "$contains(event.payload.text, 'approve')" }, "timeout": 1800000 }

{ "kind": "callModel", "id": "drive", "instructions": "…",
  "tools": [ { "type": "connection:app", "expose": "core" } ] }
```

- **Every operation must be declared.** A node's `op`, a tool entry's `ops`,
  and an event a node names must come from the slot's profile (or its parents)
  or a declared extension, and an optional profile operation must be listed in
  the slot's `ops`. Violations fail validation with
  `CONNECTION_OPERATION_UNDECLARED`.
- **Profile and extension operations are equals**, called with the same node
  and validated against their own schemas.
- **Expressions.** `args`, `target` and `spec` evaluate against the node's
  input (`33-expressions`). `filter` on `awaitEvent` evaluates against
  `{ "event": <envelope>, "input": <node input> }`; a subscription's
  expressions evaluate against the envelope. These are the only evaluation
  inputs this spec adds to spec 33.
- **Output** is the operation's result, with references and blob references
  wrapped, available to downstream nodes.
- **Fan-out** over configured instances uses `"target": { "all": true }`, or
  `inParallel` with `over`; over fresh instances, `inParallel` paths with a
  `scope: "path"` lease.
- **`secrets`** are named with `{ "$secret": name }` values, bounded by the
  host allowlist.

Schema changes in `packages/types/src/schemas/workflow.ts`:
`WorkflowDocument.connections` and `WorkflowDocument.subscriptions`; the
`connectionCall`, `acquireConnection`, `releaseConnection`, `subscribeEvents`,
`awaitEvent`, `awaitTask` and `verify` (spec 37) node kinds; the `$secret` and
`$blob` value forms; and a `connection:<slot>` variant of
`CallModelToolEntrySchema`. The published JSON Schema is regenerated with
`bun run gen:schema` (spec 26).

## Observability

- Spans: `connection.connect`, `connection.provision`, `connection.call`
  (instance, identity, op, origin, task id), `connection.task`,
  `connection.event` (source, type, subscription). Sensitive fields are
  redacted; blobs appear as references.
- Framework events on `getFullStream()`: `connection_state_changed`,
  `identity_changed`, `lease_acquired`, `lease_released`,
  `connection_event_received`, `connection_task_updated`, `event_gap`,
  `subscription_terminated`.

## Errors

Setup and validation failures are `NoeticConfigError` codes (`09-error-model`):

| Code | When |
|---|---|
| `CONNECTION_TOOL_COLLISION` | Two operations map to the same model-facing tool name. |
| `CONNECTION_VERSION_UNSATISFIED` | A slot's profile or extension range excludes the bound instance's or pool's version. |
| `CONNECTION_EXTENSION_MISSING` | A slot requires an extension the instance or pool does not offer. |
| `CONNECTION_OPERATION_UNSUPPORTED` | A slot's `ops`, or a step's operation, is not offered. |
| `CONNECTION_OBSERVATION_UNSUPPORTED` | A slot's `observes` names a channel the instance or pool does not declare. |
| `CONNECTION_OPERATION_UNDECLARED` | A node or tool entry names an operation or event its slot did not declare. |
| `CONNECTION_PROFILE_MISMATCH` | A slot is bound to an instance marked unavailable for contradicting its declared profile. |
| `CONNECTION_ALLOWLIST_EXCEEDED` | A document asks for more than the host allowlist grants. |
| `CONNECTION_POOL_NOT_PROVISIONABLE` | A pool's provider does not implement `provision`. |
| `CONNECTION_HOST_ONLY_FIELD` | A workflow sets a provisioning field marked `hostOnly`. |
| `UNKNOWN_CONNECTION_SLOT` | A node or tool entry names a slot the manifest does not declare. |
| `UNKNOWN_CONNECTION_INSTANCE` | A binding, subscription or allowlist names an instance or pool the harness does not have. |
| `INVALID_CONNECTION_REQUIREMENT` | A requirement is malformed. |

Run-time failures are `NoeticError` kinds:

| Kind | Payload | When |
|---|---|---|
| `connection_unavailable` | `instance`, `reason` | The instance is disconnected, closed, or no longer satisfies its slots. |
| `connection_pool_exhausted` | `pool`, `waitedMs` | No instance became free before `queueTimeout`. |
| `connection_operation_failed` | `instance`, `op`, `error` (spec 36 § Operation errors) | The operation ran and failed, or the server refused it. |
| `connection_reference_mismatch` | `instance`, `references` | References name another instance than the `target`, or several. |
| `connection_reference_rejected` | `kind`, `instance` | A durable reference was not issued in this provenance scope. |
| `connection_reference_stale` | `kind`, `instance` | A volatile reference belongs to an earlier identity, or its signature fails. |
| `connection_secret_not_allowed` | `instance`, `op` | A model call carried a secret reference, or a step put one in a field not marked `sensitive`. |
| `connection_input_required` | `instance`, `taskId`, `inputRequests` | A task needs input and nothing can answer it. |
| `connection_instance_replaced` | `instance`, `recorded`, `current` | Resume found a replaced instance whose determinism is `unsafe`. |
| `connection_binding_changed` | `slot`, `recorded`, `current` | A resumed run's binding no longer satisfies the recorded one. |
| `connection_subscription_terminated` | `subscription`, `reason` | The upstream ended a subscription a step was waiting on. |
| `task_lost` | `instance`, `taskId` | The server no longer knows a recorded task. |
| `event_gap` | `subscription` | A subscription with `onGap: 'fail'` received a truncated batch or overflowed. |

## Future Considerations

- Proposing the profile format and the v1 catalog upstream as an MCP extension
  through the Agents interest group and the Tasks and Events working group.
- Sharing pools and connections across several harnesses in one process.
