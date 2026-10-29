# 35 — Connections

> **Depends On:** `01-step-type` (Step), `08-runtime` (AgentHarness, ArtifactStore), `09-error-model`, `10-observability`, `11-context-layer-system`, `23a-step-level-resume` (ledger), `26-json-workflow-runtime`, `33-expressions`, `34-custom-items`, `36-connection-profiles`, `37-verification`
> **Exports:** `connection()`, `connectionTools()`, `secret()`, `defineSource()`, `cron()`, `step.call`, `step.wait`, `createInMemoryConnection()`; types `Connection`, `ConnectionProvider`, `ConnectionEvent`, `Ref`, `BlobRef`; `mcp()` (`@noetic-tools/mcp`)

---

A **connection** is a named, live thing an agent works with: a browser, an iOS
simulator, an Android emulator, a desktop app, a Slack workspace, a deploy
queue. A harness holds any number of them. On a connection an agent can:

```
          DO        LOOK         WAIT        HEAR              CHECK
        call an   read its     wait for    a trigger         verify a claim
        operation state        an event    starts a turn     (spec 37)
```

Any [MCP](https://modelcontextprotocol.io) server is a connection: its tools
reach the model as they are. A server that also speaks a **profile**
(spec 36) — a shared, versioned vocabulary such as `browser@1` or `chat@1` —
gets typed steps, a view of its state in the model's context, events, and
verification, and works with any agent written against that profile.

## Quick start

```ts
import { AgentHarness, callModel, loop, until } from '@noetic-tools/core';
import { mcp } from '@noetic-tools/mcp';

const harness = new AgentHarness({
  name: 'browser-agent',
  params: {},
  connections: { browser: mcp('npx @playwright/mcp@latest') },
  agentGraph: loop({ id: 'agent', steps: [callModel({ id: 'turn', instructions: 'Use the browser.' })], until: until.noToolCalls() }),
});

await harness.execute('Open example.com and follow the "More information" link');
```

The server's tools reach the model as `browser_<tool>`. Nothing else is needed.

## Configuring connections

`connections` maps names you choose to what backs them:

```ts
connections: {
  browser:  mcp('npx @playwright/mcp@latest'),                         // one server, one connection
  slack:    { provider: mcp({ url: 'https://slack-mcp.example.com/mcp' }),
              policy: { approve: ['chat.post'], deny: ['com.slack.admin.*'] } },
  browsers: { provider: mcp('npx playwright-noetic-mcp'), pool: { max: 8 } },  // fresh browsers on demand
  deploys:  deploySource,                                              // an in-process source (§ Triggers)
}
```

| Entry field | Meaning |
|---|---|
| `provider` | What backs it: `mcp(…)`, a source, or any `ConnectionProvider`. A bare provider is shorthand for `{ provider }`. |
| `pool` | Makes it a pool: `{ max, warm?, waitMs? }`. Each user gets a fresh connection (§ Fresh connections). |
| `policy` | `allow`, `deny` and `approve` globs over operation names (§ Gates). |
| `expose` | How its operations reach the model: `'eager'` (default), `'all'` or `'none'` (§ Model tools). |
| `look` | What the model sees of it each turn (§ Looking). |

`mcp()` takes a command line (`'npx @playwright/mcp@latest'`), `{ command, args, env }`,
or `{ url, headers }`, and `webhooks` when the server delivers events by webhook.

Providers connect when the harness starts — on the first `execute()` or `run()`,
or on an explicit `await harness.start()` for a harness that only reacts to
triggers. Construction stays synchronous. A connection that drops is marked
unavailable: its tools and steps report it, and every other connection keeps
working while it reconnects. `harness.getConnectionStatus(name?)` reports each
one's state.

## Model tools

How a connection's operations reach the model is its `expose` setting:

| `expose` | Tools |
|---|---|
| `'eager'` (default) | The operations its profile marks `eager`, plus two tools for the rest: `<name>_ops` lists them and `<name>_call` runs one. |
| `'all'` | Every operation as its own tool. |
| `'none'` | None; the connection is for steps and triggers only. |

A server with no profile has no eager set, so its tools are exposed as they
are. Every call through any of these tools passes the same gates as a step
(§ Gates).

When two connections offer the same profile operation — `ui.tap` on an `ios`
and an `android` device — the model gets one `ui_tap` tool with a `target`
argument naming the connection, instead of two near-identical tools. A
`callModel` step can narrow what it offers with
`connectionTools(app, { ops: ['ui.*'] })`.

## Looking

A profile names the state worth showing the model — a page's URL and title, a
device's foreground app, a thread's recent messages — and each connection gets
a context layer that renders it. `look` sets when each piece is read:

```ts
look: { 'browser.page.summary': 'turn', 'ui.tree': 'effect', 'screen.current': 'ask' }
```

| Mode | Read |
|---|---|
| `'turn'` | Every turn. For cheap summaries. |
| `'effect'` | After an operation that changed the connection. |
| `'ask'` | Only when the model asks, through `<name>_call({ read })`. |

Profiles choose sensible defaults: a short summary every turn, a full tree
after changes, screenshots only on request. Repeated reads render as diffs, and
each read's token cost is recorded in traces.

## Steps

```ts
import { connection, secret, step, inParallel } from '@noetic-tools/core';
import { browser } from '@noetic-tools/profile-browser';

const app = connection('app', browser, { fresh: 'path', setup: { url: 'http://localhost:5173/login' } });

const login = [
  step.call({ id: 'email',    connection: app, op: 'ui.fill', args: { element: 'textbox "Email"', text: 'qa@example.com' } }),
  step.call({ id: 'password', connection: app, op: 'ui.fill', args: { element: 'textbox "Password"', text: secret('app.password') } }),
  step.call({ id: 'sign-in',  connection: app, op: 'ui.tap',  args: { element: 'button "Sign in"' } }),
];
```

- **`connection(name, profile?, options?)`** declares a connection a workflow
  needs and returns a handle. With a profile, `op`, `args` and outputs are
  typed by it, and the profile's range defaults to the installed package's
  version (`^1.2.0`); `browser.range('^1.1')` overrides it. The handle binds to
  the harness connection of the same name, or to `options.from`.
- **`step.call({ id, connection, op, args })`** runs one operation and
  returns its result. Operations that run long upstream (an app install, a
  test run) are waited for automatically.
- **`step.wait({ id, connection, event, filter?, around?, timeoutMs })`**
  waits for an event. With `around`, it starts listening, runs `around`, then
  waits — so the event an action causes cannot slip past:

  ```ts
  step.wait({
    id: 'approval', connection: team, event: 'chat.message.created',
    filter: (e, input) => e.payload.thread.id === input.thread.id && /approve/i.test(e.payload.text),
    around: step.call({ id: 'ask', connection: team, op: 'chat.reply', args: (input) => ({ thread: input.thread, text: 'Approve?' }) }),
    timeoutMs: 18e5,
  });
  ```

  Its output is `{ event, around }`.
- **`step.verify`** checks claims about what a connection shows (spec 37).
- `args` may be a value or a function of the step's input; `around` and
  `act` (spec 37) take a step or an array of steps, run in order.

### Fresh connections

A handle with `fresh` gets its own connection from a pool, and gives it back
when the scope ends:

| `fresh` | One connection per |
|---|---|
| `'run'` | Run: every step in the run shares it. |
| `'path'` | Parallel path: each `inParallel` path gets its own. |

`from` names the pool (default: the handle's name); `setup` is passed to the
pool's provider — a start URL, a stored session, a viewport, a device model —
and is validated against the profile's setup schema (spec 36). A pool that is
full queues the request until a connection is free or `waitMs` passes.

```ts
const app = connection('app', browser, { from: 'browsers', fresh: 'path', setup: { url: previewUrl } });
inParallel({ id: 'suite', mode: 'all', paths: [checkoutFlow(app), signupFlow(app)] });  // two fresh browsers
```

### Values

| Value | What it is |
|---|---|
| **Locator** | A string where an operation expects an element: `'button "Pay"'` (role, then quoted name). The server resolves it to exactly one element or refuses with `ambiguous`; it never guesses. |
| **Ref** | An id a connection handed out — a thread, a message, an installed app. Pass it back as you got it; the harness routes the call to the connection that issued it. In TypeScript a `Ref` has `connection`, `kind` and `id`; in JSON it is `{ "$ref": … }`, read with `$refId(x)`. |
| **Blob** | Binary content — a screenshot, a recording, a download — stored once in the artifact store (`08-runtime`) and passed around as a small reference. |
| **Secret** | `secret('app.password')`: resolved only when the call is sent, never stored, logged or shown to the model, and allowed only in fields a profile marks `sensitive`. |

## Triggers

A **trigger** starts or joins a turn when a connection reports an event:

```ts
new AgentHarness({
  connections: { slack: mcp({ url: SLACK_MCP }), morning: cron('0 8 * * *', { timezone: 'America/New_York' }) },
  triggers: [
    { id: 'mentions', connection: 'slack', event: 'chat.message.created',
      arguments: { mentionsAgent: true },                 // filter on the server
      filter: (e) => !e.payload.author.isBot,             // filter here
      input: (e) => e.payload.text },
    { id: 'daily', connection: 'morning', event: 'tick', input: () => 'Write the daily summary' },
  ],
});
```

Each matching event starts a turn on its thread — `thread(event)`, defaulting
to the profile's natural thread for that event (a chat thread) or the trigger's
id — with `input(event)` as the message. The event itself is attached to the
turn as a `noetic:connection_event` item, so steps can read it. A trigger
delivers each event once, even across crashes (§ Durability).

**Sources** are event streams you write in code — a queue consumer, a file
watcher, a webhook from your own app — registered as connections:

```ts
const deploys = defineSource({
  events: { 'deploy.failed': DeployFailedSchema },
  async start({ emit, cursor, signal }) {
    for await (const msg of queue.consume({ after: cursor, signal })) {
      await emit({ type: 'deploy.failed', id: msg.id, payload: msg.body, cursor: msg.offset });
    }
  },
});

deploys.emit({ type: 'deploy.failed', id: run.id, payload });   // or push from host code
```

`cron(schedule, { timezone })` is a built-in source with one event, `tick`,
delivered once per scheduled time even after downtime.

A chat bot that answers every message — streaming replies, tool cards,
history — belongs on `@noetic-tools/chat-sdk` (spec 29). Chat connections are
for agents that start conversations or wait on people: post a question, wait
for the answer.

## JSON workflows

A document lists the connections it needs, each with a version range:

```json
{
  "version": 1,
  "connections": {
    "app":     { "profile": "browser@^1.2", "from": "browsers", "fresh": "path", "setup": { "url": "http://localhost:5173/login" } },
    "phone":   { "profile": "device@^1", "extensions": { "com.acme.ios-permissions": "^1.0" } },
    "deploys": { "events": ["deploy.failed"] }
  },
  "root": { "kind": "sequence", "id": "main", "steps": [
    { "kind": "call", "id": "email", "connection": "app", "op": "ui.fill",
      "args": { "element": "textbox \"Email\"", "text": "qa@example.com" } },
    { "kind": "call", "id": "password", "connection": "app", "op": "ui.fill",
      "args": { "element": "textbox \"Password\"", "text": { "$secret": "app.password" } } },
    { "kind": "call", "id": "sign-in", "connection": "app", "op": "ui.tap",
      "args": { "element": "button \"Sign in\"" } }
  ] }
}
```

- **The manifest.** Each entry names a `profile` with a range, `extensions`
  with ranges, or for a source the `events` it needs; plus `from`, `fresh` and
  `setup` for pooled connections. Every operation and event a node uses must
  come from what its entry declares; anything else fails validation. The
  optional operations a document uses are worked out from its nodes, so they
  are never listed twice.
- **Nodes.** `call`, `wait` and `verify` (spec 37), shaped like their
  TypeScript builders. Inside `around`, `act` or any array of steps, an
  operation can be written by name: `{ "ui.tap": { "element": "button \"Pay\"" } }`
  is a `call` on the enclosing connection (the `verify` subject, or the
  document's only connection).
- **Values.** `{ "$expr": "…" }` is an expression (`33-expressions`),
  evaluated against the node's input with `$steps` holding the outputs of
  earlier nodes by id; `{ "$literal": … }` passes an object through untouched;
  `{ "$secret": "name" }` is a secret; refs and blobs appear as they were
  returned. `$refId(x)` reads a ref's id inside an expression.
- **Fan-out.** `inParallel` with `over` a list of connection names and
  `"connection": { "$expr": "$item" }` on its nodes runs the same steps on each,
  every name checked against the manifest.

### What a document may use

A document's manifest says what it needs; the host decides what it may have.
`dynamicWorkflow` — where a model writes the document — requires an allowlist,
and `parseAndRunWorkflow` accepts one:

```ts
dynamicWorkflow({
  connections: {
    browsers: { ops: ['ui.*', 'browser.*'], setup: { url: ['http://localhost:*'] },
                secrets: { 'app.password': 'ui.fill.text' } },
    slack:    { ops: ['chat.reply'], events: ['chat.message.created'] },
  },
});
```

Each entry grants operation and event globs, the `setup` values a document may
choose (patterns per field), and the secrets it may use, each bound to one
operation field. A manifest asking for more fails validation with
`CONNECTION_NOT_ALLOWED`. `dynamicWorkflow` shows the model only the allowed
connections and operations, with their argument schemas, and fills in the
manifest's version ranges itself.

## Gates

Every connection call — from the model, a step, or a document — passes the
same gates, in order:

1. The operation exists on the connection, and for steps and documents is
   declared by the manifest or handle.
2. Its arguments match the operation's schema. Nothing is defaulted on the
   caller's behalf.
3. Its refs were issued by this harness to this thread; the call is routed to
   the connection that issued them.
4. The connection's `policy`. Operations a profile marks `guarded`, and
   targets a server refuses as `guarded`, need approval unless the policy
   allows them.
5. `beforeToolCall` layers and the harness approver, as for any tool.
6. Secrets are filled in, and the call is sent.

A refusal fails a step with `steering_denied` and returns a tool error to the
model. Author-written steps are gated like everything else.

## Errors

Setup and validation (`NoeticConfigError`):

| Code | When |
|---|---|
| `CONNECTION_UNKNOWN` | A handle, node, trigger or allowlist names a connection the harness does not have. |
| `CONNECTION_UNSATISFIED` | A connection does not offer what is required. `missing` says which: a profile or extension version, an operation, an event, or a sense (spec 37). |
| `CONNECTION_NOT_ALLOWED` | A document asks for more than its allowlist grants, or sets a setup field reserved to the host. |
| `CONNECTION_INVALID` | A manifest entry or handle is malformed. |
| `CONNECTION_TOOL_COLLISION` | Two operations would reach the model under one tool name. |

Run time (`NoeticError` kinds):

| Kind | Payload | When |
|---|---|---|
| `connection_unavailable` | `connection`, `reason` | Disconnected, its pool stayed full past `waitMs`, or an event stream it was waiting on ended. |
| `connection_failed` | `connection`, `op`, `error` | The server refused or failed the operation; `error.code` is from spec 36 § Errors. |
| `connection_ref_invalid` | `connection`, `reason` | A ref was not issued here, belongs to another connection than the call's target, or is stale. |
| `connection_secret_refused` | `connection`, `op` | A secret was used outside a `sensitive` field or by the model. |
| `connection_input_required` | `connection`, `request` | A long-running operation asked a question nobody could answer. |
| `connection_resume_refused` | `connection`, `reason` | A resumed run's connection was replaced and cannot safely be driven again (§ Durability). |

Framework events on `getFullStream()`: `connection_changed` (state, identity,
lease), `connection_event` (an event received), `connection_task` (progress of
a long operation), and `stream_changed` (a gap or an ended event stream).

---

## Under the hood

The rest of this spec is for people writing providers and for understanding
durability. Workflow authors do not need it.

### Packages

```
@noetic-tools/core ────────→ @noetic-tools/types   (contract)
@noetic-tools/mcp ─────────→ @noetic-tools/types   (+ MCP SDK)
@noetic-tools/agent-plugins → @noetic-tools/mcp, @noetic-tools/types
@noetic-tools/profile-* ───→ @noetic-tools/types   (+ the profile each extends)
@noetic-tools/verify ──────→ @noetic-tools/types   (+ open-verification)
@noetic-tools/platform-node → @noetic-tools/core   (file artifact store, webhook receiver)
```

`@noetic-tools/core` never imports `@noetic-tools/mcp`, the MCP SDK, a profile
package or `@noetic-tools/verify`; it receives providers, profiles and a
verifier from the caller. Only `@noetic-tools/mcp` imports the MCP SDK.
`@noetic-tools/agent-plugins` registers each plugin MCP server as a connection
with no profile, through `@noetic-tools/mcp`, so a plugin's tools and a
configured server's tools share one registry, one naming rule and one set of
gates. `.sentrux/rules.toml` enforces each boundary and gives each package a
layer.

### The provider contract

```ts
interface ConnectionProvider {
  connect(opts: ConnectOptions): Promise<ReadonlyArray<Connection>>;
  /** Present on providers that can back a pool. */
  provision?(setup: Record<string, unknown>, opts: ConnectOptions): Promise<Connection>;
}

interface Connection {
  readonly id: string;
  readonly manifest: ConnectionManifest;         // profiles, extensions, operations, resources, events
  readonly identity: ConnectionIdentity;         // OVP subject
  call(op: string, args: unknown, opts: CallOptions): Promise<CallResult>;
  read(resource: string, opts: { signal: AbortSignal }): Promise<unknown>;
  listen(req: ListenRequest): EventStream;
  readonly tasks: ConnectionTasks;
  reset?(opts: { signal: AbortSignal }): Promise<void>;
  onChange(listener: (change: 'manifest' | 'identity') => void): () => void;
  readonly closed: Promise<{ reason: string }>;
  release(): Promise<void>;
}

interface ConnectionIdentity { surface: string; instance: string; epoch?: number }
```

`createInMemoryConnection()` implements the whole contract as scripted
functions, events and tasks for tests; given `provision`, it also backs pools.

`mcp()` implements it over MCP: tools for operations, resources for reads, the
[Tasks extension](https://modelcontextprotocol.io/seps/2663-tasks-extension)
(SEP-2663) for long operations, and the
[Events extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415)
(SEP-3415) for events. It reads a server's profile declaration (spec 36 §
Declaring a server) during capability discovery and checks the server's tools
against it; a server whose tools contradict its declared profile is marked
unavailable. A server with no declaration is a connection with no profile: its
tools pass through, it has no reads, events or verification, and its identity
is the MCP session.

### Connection registry

Steps, tools and documents never hold a provider's `Connection`. They resolve
connections by name through the harness's registry when they run, which wraps
each one with the gates, refs, blobs, secrets, identity tracking,
reconnection and pool leases. A step that runs after a reconnect therefore uses
the new connection, and nothing can reach a server around the harness.

### Negotiation

A handle's or manifest entry's requirements are semver ranges for a profile
(which imply its parents' ranges, spec 36) and its extensions, plus the
optional operations, events and senses derived from use. They are checked when
the harness starts for its own graph, before a run's root executes for
documents, and for pools against the pool's declaration before anything is
provisioned. When a connection's manifest changes (a server upgrade), it is
renegotiated; tools change at the next turn, never mid-turn, and a connection
that no longer satisfies what uses it becomes unavailable.

### Pools and leases

A pool's provider implements `provision`. A lease is held by one run or one
parallel path and is never shared with another. The holding harness renews it
every 15 s; one not renewed for 2 min is reclaimed, so a crashed process frees
its browsers, and a process that resumes within that time keeps the same lease.
Setup fields a profile marks `hostOnly` — the command or path of an app — come
only from the pool's own `setup`, never from a workflow.

### Refs and blobs

A ref is `{ $ref: { connection, kind, id, seal } }`. `seal` is an HMAC over the
rest, the issuing thread and, for refs a profile marks volatile (elements,
windows), the connection's identity instance. The harness checks it on the
way out, so a ref cannot be forged, used from another thread (spawned children
and parallel paths share their parent's thread), or reused after the thing it
pointed into was replaced. Signing keys live in the harness `StorageAdapter`
and rotate with an overlap, so refs survive a restart. Refs a profile marks
`public` — a channel id a person can type — skip the thread check.

The bridge stores every binary MCP content block in the artifact store and
replaces it with `{ $blob: { uri, mimeType, bytes, sha256 } }`. Blobs are
scoped like refs, and blobs a profile marks sensitive (a stored session) are
never rendered to the model.

### Secrets

The harness resolves a secret through `environment.secrets` immediately before
sending the call. Before any output, event, read or text artifact is stored,
traced or shown to the model, the harness replaces every resolved secret value
in it — and its URL-encoded and base64 forms — with `"<redacted>"`. Pixels
cannot be scrubbed; profiles require servers to mask sensitive fields on
screen.

### Events

`mcp()` receives events by push (`events/stream`), webhook (`events/subscribe`,
when given a webhook receiver) or poll (`events/poll`), preferring them in that
order; callers never see the difference. Webhook deliveries are verified
(Standard Webhooks signature, five-minute timestamp window, duplicate ids
dropped) and their `terminated` and `gap` control messages handled.

An event reaches the harness as:

```ts
interface ConnectionEvent<T = unknown> {
  id: string; type: string; time: string; payload: T;   // SEP-3415 eventId, name, timestamp, data
  cursor: string | null;
  connection: string;                                     // stamped by the harness
  actionId?: string;                                      // the action it is attributed to
}
```

Two kinds of listening use it:

- **Waits** (`step.wait`, verification windows) listen in memory for the
  life of the step, from the moment the server confirms the subscription.
  They buffer up to 1e4 events; overflow drops the oldest and records a gap,
  which verification reports as a blind spot.
- **Triggers** listen for the life of the harness. Matching events are written
  to a durable inbox together with the advanced cursor, delivered as turns with
  message id `<connection>:<trigger>:<event id>`, and recorded as done when
  their turn completes. Events are deduplicated per trigger, as SEP-3415
  scopes deduplication.

### Durability

**Idempotency keys.** Every call carries a key derived from the run and the
step's ledger key (or the turn and tool call id), as
`_meta["tools.noetic/idempotency-key"]`. Operations a profile marks `once` —
lasting effects such as posting a message or installing an app — must return
their original outcome for a repeated key instead of acting again.

**Pending entries.** A `call` or `wait` writes a pending ledger entry before
it reaches a server — its key, the connection's identity, and once known the
task, the lease, the start cursor and the deadline. On resume against the same
identity, a step with a pending entry and no result picks up where it was:
re-sending with the same key, waiting on the same task, or listening again from
the recorded cursor until the recorded deadline.

**A replaced connection.** If a connection's identity instance changed — the
browser restarted, the lease expired, the simulator was reset — results
recorded against it describe a world that is gone. Its determinism (spec 36)
decides, following OVP's resume strategy:

| Determinism | Resume |
|---|---|
| `replayPrefix: 'free'` | Discard the ledger from the first step that used the connection and run live from there. |
| `replayPrefix: 'costly'`, with `reset` | Reset the connection, then the same. |
| `replayPrefix: 'unsafe'` | Stop with `connection_resume_refused` until `harness.resume(id, { rerun: ['app'] })`. |

Everything after the discarded point runs live too, model rounds included,
because its inputs came from the old connection. Calls marked `once` still
carry their original keys. An epoch change alone (a hot reload) keeps refs and
results.

## Future Considerations

- Explicit `acquire`/`release` steps for connections whose lifetime does not
  match a run or a path.
- Starting work and waiting for it in separate steps.
- JSON `triggers`, so a document can carry its own standing triggers.
- Proposing the profile format and catalog upstream as an MCP extension.
