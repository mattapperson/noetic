# 35 — Connections

> **Depends On:** `01-step-type` (Step), `08-runtime` (AgentHarness, ArtifactStore), `09-error-model`, `10-observability`, `11-context-layer-system`, `23a-step-level-resume` (ledger), `26-json-workflow-runtime`, `33-expressions`, `34-custom-items`, `36-connection-profiles`, `37-verification`
> **Exports:** `connection()`, `connectionTools()`, `secret()`, `defineSource()`, `cron()`, `step.call`, `step.wait`, `createInMemoryConnection()`, `isConnectionEntry()`, `isConnectionPick()`; types `Connection`, `ConnectionProvider`, `ConnectionEntries`, `ConnectionPick`, `ConnectionEvent`, `Ref`, `BlobRef`; `mcp()` (`@noetic-tools/mcp`)

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
  connections: [mcp({ name: 'browser', command: 'npx', args: ['@playwright/mcp@latest'] })],
  agentGraph: loop({ id: 'agent', steps: [callModel({ id: 'turn', instructions: 'Use the browser.' })], until: until.noToolCalls() }),
});

await harness.execute('Open example.com and follow the "More information" link');
```

The server's tools reach the model as `browser_<tool>`. Nothing else is needed.

## Configuring connections

`connections` names what backs each connection. It is a record keyed by the
names you choose, or a list of entries each named by its provider:

```ts
connections: [mcp({ name: 'linear', type: 'http', url: LINEAR_MCP, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] })]
```

The two forms are the same connection. A record key and `mcp({ name })` that
disagree, or a list entry with no name, is `CONNECTION_INVALID`. Names follow
`CONNECTION_NAME_PATTERN`: a letter, then letters, digits, `_` and `-`.

```ts
connections: {
  browser:  mcp({ command: 'npx', args: ['@playwright/mcp@latest'] }),     // one server, one connection
  slack:    { provider: mcp({ type: 'http', url: 'https://slack-mcp.example.com/mcp' }),
              policy: { approve: ['chat.post'], deny: ['com.slack.admin.*'] } },
  browsers: { provider: mcp({ command: 'npx', args: ['playwright-noetic-mcp'] }), pool: { max: 8 } },  // fresh browsers on demand
  deploys:  deploySource,                                              // an in-process source (§ Triggers)
}
```

| Entry field | Meaning |
|---|---|
| `provider` | What backs it: `mcp(…)`, a source, or any `ConnectionProvider`. A bare provider is shorthand for `{ provider }`. |
| `pool` | Makes it a pool: `{ max, warm?, waitMs? }`. Each user gets a fresh connection (§ Fresh connections). |
| `policy` | `allow`, `deny` and `approve` globs over operation names (§ Gates). |
| `expose` | How its operations reach the model: `'eager'` (default), `'all'`, `'call'` or `'none'` (§ Model tools). |
| `look` | What the model sees of it each turn (§ Looking). |

`mcp()` takes ACP's `McpServer` shape, so an ACP server config is an argument
as it stands: `{ name, type: 'http' | 'sse', url, headers? }` for a remote
server, `{ name, command, args?, env? }` for a stdio one (`type: 'stdio'` is
accepted too), with each header and environment variable as `{ name, value }`;
or `{ transport }` for a caller-built transport. The bridge options sit beside
those fields: `auth`, `fetch`, `cwd`, `spawn`, `webhooks` (when the server
delivers events by webhook), `profiles`, `extensions`, `timeoutMs`,
`requestTimeoutMs`, `pollIntervalMs` and `clientInfo`. A header or environment
variable given twice is `CONNECTION_INVALID`. The options of an entry —
`policy`, `expose`, `look`, `pool` — live on the entry, never on `mcp()`. A stdio server that must run
somewhere else (the machine an ACP agent runs on, a container) takes
`spawn`, a `Spawn` from `@noetic-tools/types` — `(command) => Promise<ByteStream>`:
the caller starts the process there and hands back its stdio as a
`{ readable, writable, close }` stream, and the bridge speaks MCP over it as it
does over a local subprocess. An ACP agent's `AcpAgent.spawn` is one, so a
JSON `acp-agent` node's stdio `{ "mcp" }` entry starts where the agent runs
(spec 26 § Tools).

A remote server's `auth` is how the bridge signs in:

```ts
linear: mcp({ type: 'http', url: 'https://mcp.linear.app/mcp', auth: { kind: 'bearer', token } }),
drive:  mcp({ type: 'http', url: DRIVE_MCP, auth: { kind: 'oauth', provider } }),  // an MCP SDK OAuthClientProvider
```

`bearer` sends `Authorization: Bearer <token>`. `oauth` hands the provider to
the MCP SDK transport, which reads its tokens and, on a 401, runs discovery
(`WWW-Authenticate`, protected-resource and authorization-server metadata),
refresh or authorization through it. `auth` and an `Authorization` header are
refused together (`CONNECTION_INVALID`). Configured headers and the credential
go to the server's origin only: they are dropped from a redirect to another
origin, and configured headers from any request the SDK sends straight to
another origin (the authorization server). The bridge registers every
credential it may carry with the harness through `ConnectOptions.redact`, so
each is scrubbed like a resolved secret (§ Secrets): the `auth` token, every
OAuth access and refresh token the provider hands out or saves, an
`Authorization` header's value and its bearer token, every other header value,
the URL's userinfo and query values, and every stdio `env` value. Values
shorter than 8 characters and absolute paths or path lists are skipped: they
are flags and locations, not credentials, and scrubbing them would mangle
ordinary output.

Providers connect when the harness starts — on the first `execute()` or `run()`,
or on an explicit `await harness.start()` for a harness that only reacts to
triggers. Construction stays synchronous. A connection that drops is marked
unavailable: its tools and steps report it, and every other connection keeps
working while it reconnects. `harness.getConnectionStatus(name?)` reports each
one's state. `await harness.close()` stops triggers and releases every
connection and pool lease (and closes the harness's ACP sessions) when the
host is done; it closes everything even when one part throws, then rethrows
the first failure.

The harness keeps its registry, secret resolver and verifier private: nothing
holding `ctx.harness` — a tool, a step, a context layer — can reach a
connection except through the gates, or resolve a secret.

## Attaching connections

One entry — `mcp(…)` or any `ConnectionProvider` — is the one way to give an
agent a server. It can be attached at three levels:

```ts
const linear = mcp({ name: 'linear', type: 'http', url: LINEAR_MCP, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] });

new AgentHarness({ agentGraph, connections: [linear] });  // for the harness's life
harness.execute(input, { connections: [linear] });       // for this turn
callModel({ tools: [linear, search] });                   // for this step
callModel({ tools: [connectionTools('linear', { ops: ['get_*'] }), search] });  // part of one, by name
```

However it is attached, the model sees the same tool names, every call passes
the same gates, approval and secret handling work the same, and the results,
events and spans are the same. A turn or step entry also reports `closed` on
`connection_changed` when the turn ends.

| Level | Connects | Released |
|---|---|---|
| Harness (`connections`) | at `harness.start()` | at `harness.close()` |
| Turn (`execute(…, { connections })`) | at the turn start, before its tool set is built | when the turn ends |
| Step (an entry in a `callModel` or `acpAgent` step's `tools`) | with the turn's entries | with them |

No connection the turn can see connects mid-turn. The turn's tool set is built
once, when it starts, and every model call sends all of it and narrows it by
name, which keeps the prompt cache stable. So:

- **Step entries** are found by walking the turn's graph, as its tools are
  (every `callModel` and `acpAgent` step's eager `tools`; spawn children
  included). They join the turn's set and are
  offered only by the steps that list them. An `acpAgent` step serves them to
  its agent through the tool bridge, by the same names (spec 27 § Tools).
- **A graph built mid-turn** — a JSON document a step hydrates and runs
  through the harness (spec 26 § Tools) — did not exist when the turn started.
  When the harness runs it, its step entries and the `{ "mcp" }` entries of
  its `connections` join the turn's attachment (released with the turn) and their tools join the pool for that run only, so
  the rest of the turn keeps the tool set it started with.
- **Function-form `tools`** (`(ctx) => […]`) cannot be walked. An entry they
  return must already be attached by the harness or the turn, with the same
  provider and options; any other is `CONNECTION_INVALID`, with a hint to move
  it to the harness or the turn.
- **Pools** stay at the harness. A turn or step entry with `pool` is
  `CONNECTION_INVALID`.
- **A pick by name** (`connectionTools('linear')`, JSON `{ "connection" }`)
  must name a connection the turn can see once its entries are attached; any
  other fails with `CONNECTION_UNKNOWN` there, before a step runs.
- **`toolChoice: { tool }`** naming a connection tool cannot be checked when
  the step is built, because the names come from the server. It is checked
  when the turn's tool set is built, and fails there with `UNKNOWN_TOOL_CHOICE`.
- **Spawned children** see the connections of their root turn, and are
  released with it.
- **A session that outlives its turn** (an ACP connection with `keepAlive`
  `'run'` or `'harness'`) holds the turn's entries through the registry's
  `hold(rootId)`, which defers their release until the connection closes. A
  hold taken before the turn attaches anything holds what it attaches later.
- **Detaching** closes each entry at once. A connect or reconnect still in
  flight finishes against a closed entry, so it releases what it got instead
  of reviving it.
- **Resume.** A resumed turn attaches its entries again from the same call
  (a re-delivered message carries its options), and its ledger is checked
  against them by name, as for a harness connection (§ Durability).

**Identity is the name.** An entry whose name is already attached in its scope
or an outer one — the harness, then the turn, then a step — is that same
connection when it has the same provider and options, and is not connected
again. Otherwise it fails with `CONNECTION_NAME_TAKEN`, so an inline entry can
never resolve to another server's credentials.

**What can use what.** `step.call`, `step.wait`, `step.verify` and
`connection()` handles reach harness and turn connections by name. A step
entry is reached only through the model tools built from it. Triggers reach
harness connections only; any other name is `CONNECTION_UNKNOWN`.

## Model tools

How a connection's operations reach the model is its `expose` setting:

| `expose` | Tools |
|---|---|
| `'eager'` (default) | The operations its profile marks `eager`, plus two tools for the rest: `<name>_ops` lists them and `<name>_call` runs one. |
| `'all'` | Every operation as its own tool. |
| `'call'` | Only `<name>_ops` and `<name>_call` (which also reads, `{ read }`). No view layer renders its reads; the model lists them with `<name>_ops`. |
| `'none'` | None; the connection is for steps and triggers only. |

A server with no profile has no eager set, so its tools are exposed as they
are. Every call through any of these tools passes the same gates as a step
(§ Gates).

When two connections offer the same profile operation — `ui.tap` on an `ios`
and an `android` device — the model gets one `ui_tap` tool with a `target`
argument naming the connection, instead of two near-identical tools. Two or
more `'call'` connections likewise share one `ops` and one `call`, each taking
`target`, so a host with many servers offers two tools, not two per server.

### Step tools

A model step with no `tools` is offered every tool of the turn except those of
the connections only some step lists; `tools: []` offers none. A step that
lists tools is offered only those:

- `tools: [linear]` offers that connection's tools;
- `tools: [connectionTools('linear', { ops: ['get_*'] })]` offers the ones
  whose operations match `ops`.

`connectionTools(nameOrHandleOrEntry, { ops? })` returns a `ConnectionPick`. It
cuts the turn's tool set to what the step picks, and the names are always the
turn's names: `<name>_<op>`, `<name>_ops` / `<name>_call`, and merged profile
tools that take `target`. `ops` globs match operation and read names alike.
Each tool is cut, not just offered or held back:

- `<name>_<op>` is offered when its operation matches.
- A merged tool (`ui_tap`, or the shared `ops` / `call`) reaches only the
  connections the step lists: its `target` enum, its routing and, for `call`,
  each target's operations and reads are cut to what that connection's picks
  allow. A call naming any other target is `steering_denied`. One picked
  connection keeps the merged name and a one-value `target`.
- `<name>_ops` lists, and `<name>_call` runs, only the picked operations and
  reads; anything else is `steering_denied`. `<name>_call({ read })` serves
  only `'ask'` reads (every read when no view renders the connection).

A step with no `tools` is cut the same way to the connections only some step
lists, so a merged tool spanning one is offered without it. The step's request
sends each cut tool in the turn tool's place, so the model sees the `target`
enum it may use; a step whose tools are all whole sends the turn's set
unchanged. Picking from an
entry attaches it to the step, as listing the entry does. A handle with
`fresh` is `CONNECTION_INVALID` (a pool has no model tools); a handle with a
profile adds its range to what the graph requires (§ Negotiation). A name picks
a harness or turn connection; a malformed one is `CONNECTION_INVALID`, and one
no connection has fails with `CONNECTION_UNKNOWN` when the turn's tool set is
built.

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
  `act` (spec 37) take a step or an array of steps. As in the other places that
  accept an array of steps (spec 01, Arrays of steps — `harness.run(login, …)`
  among them), an array runs its steps in sequence, each output the next one's
  input, so there is no `step.sequence`.

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
inParallel({ id: 'suite', mode: 'all', paths: () => [checkoutFlow(app), signupFlow(app)], merge: (results) => results });  // two fresh browsers
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
  connections: { slack: mcp({ type: 'http', url: SLACK_MCP }), morning: cron('0 8 * * *', { timezone: 'America/New_York' }) },
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
- **A document's own servers.** An entry may instead be `{ "mcp": … }`, the
  same entry a node's `tools` take (spec 26 § Tools): `"linear": { "mcp": {
  "name": "linear", "type": "http", "url": "…", "headers": [{ "name":
  "Authorization", "value": { "$secret": "linear.token" } }] } }`. Its key and
  `mcp.name` must agree, and it takes no `from`, `fresh` or `setup`; otherwise
  `CONNECTION_INVALID`. It is attached when the document runs, as a turn
  connection that every node reaches by name, and released with the turn. The
  host's `mcp` allowlist grants it, not the `connections` allowlist.
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

A document's manifest says what it needs; the host decides what it may have,
through the `connections` allowlist of `dynamicWorkflow` and
`parseAndRunWorkflow`:

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

The same allowlist bounds a document's `{ "connection", "ops"? }` tool entries
(spec 26 § Tools): the name must be granted, each `ops` glob must lie inside a
granted operation glob, and a pick without `ops` takes exactly the granted
operations. The allowlist may name a turn connection as well as a harness one.
A `callModel` or `acp-agent` node with no `tools` is offered only the granted
connections, with their granted operations, and the MCP servers the document
attaches; its other tools are those of any step with no `tools`.

Both functions grant nothing without an allowlist, as with `acp` and
`mcp`: no `connections` is `connections: {}`. Under it a manifest entry, a
`{ "connection" }` pick or a `call`, `wait` or `verify` node that names a
harness connection is refused, and a `callModel` or `acp-agent` node with no
`tools` is offered no connection. A host that trusts a document passes the
grants it wants it to have.
A document's inline `{ "mcp" }` servers are granted by a separate `mcp`
allowlist, which also sets each server's secrets and `policy` (spec 26 § MCP
servers); a document never sets a policy.

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
| `CONNECTION_UNKNOWN` | A handle, node or trigger names a connection the harness does not have, an allowlist one neither the harness nor the turn has, or a pick by name (`connectionTools('x')`, `{ "connection": "x" }`) one the turn cannot see when its tool set is built. |
| `CONNECTION_UNSATISFIED` | A connection does not offer what is required. `missing` says which: a profile or extension version, an operation, an event, or a sense (spec 37). |
| `CONNECTION_NOT_ALLOWED` | A document asks for more than its allowlist grants — a manifest, a `{ "connection" }` tool entry or its `ops`, or an MCP server the `mcp` allowlist does not grant — or sets a setup field reserved to the host. |
| `CONNECTION_INVALID` | A manifest entry, handle, harness entry or `mcp()` configuration is malformed: an unnamed list entry, a header or environment variable given twice, `auth` with an `Authorization` header, a `connectionTools()` name that is not a connection name, a document `{ "mcp" }` entry whose key and name disagree, a record key that disagrees with `mcp({ name })`, a turn or step entry with `pool`, or a function-form `tools` returning a connection nothing attached, or a document naming an MCP server when the `mcp` allowlist has no `provider`. |
| `CONNECTION_NAME_TAKEN` | An entry names a connection its scope or an outer one already attaches with a different provider or options. |
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
`@noetic-tools/agent-plugins` turns each plugin MCP server into an `mcp()`
connection entry with `expose: 'call'` (`pluginConnections()`), which a host
attaches to the harness or a turn, so a plugin's tools and a configured
server's tools share one registry, one naming rule and one set of gates. `.sentrux/rules.toml` enforces each boundary and gives each package a
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

`ConnectOptions` carries `redact(value)`: a provider calls it with every
credential it holds (a bearer token, an OAuth token), and the harness scrubs
that value as it scrubs resolved secrets.

Each `ConnectionOperationInfo` in a manifest may carry `annotations` — the
server's hints about the operation: `title`, `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`. `mcp()` copies them from
the MCP tool's `annotations` (a malformed hint is dropped, not the tool). They
are claims, not guarantees: a host may use them to choose a default `policy`
(a read-only operation allowed, a destructive one approved), but the gates
never trust them in place of a `policy` or a profile's `guarded`.

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
reconnection and pool leases. A turn attaches its own entries to the same
registry under its root context (`attach(root, entries)`), and `detach(rootId)`
releases them; a name resolves to the harness's entry first, then to the one
the caller's turn attached. A step that runs after a reconnect therefore uses
the new connection, and nothing can reach a server around the harness.

### Negotiation

A handle's or manifest entry's requirements are semver ranges for a profile
(which imply its parents' ranges, spec 36) and its extensions, plus the
optional operations, events and senses derived from use. They are checked when
the harness starts for its own graph, and before a root executes for documents
and for any other step `run()` is given (after the providers connect). A root
counts as negotiated only once every connection it needs was checked: one
whose connection was down, or whose pool has provisioned nothing yet, is
checked again on its next run, and meanwhile fails at the step that uses it. A
pool is checked against the manifest of a connection it provisioned with no
setup — a `warm` one, or any provisioned on demand without one. A provider may
answer a setup with a different manifest, so a need whose handle passes a
`setup` is checked only when its lease is acquired. Every lease is checked again
when it is acquired. When a connection's manifest changes (a server upgrade), it is
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
in it — and every credential a provider registered through
`ConnectOptions.redact`, and their URL-encoded and base64 forms — with
`"<redacted>"`. A connection's unavailable `reason` is scrubbed the same way. Pixels
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
step's ledger key, or for a model tool call `<execution>:tool:<callId>`, as
`_meta["tools.noetic/idempotency-key"]`. `callId` is
`ToolExecutionContext.callId`: the model's call id on `callModel`, and the
agent's own call id for a call an ACP agent makes through the tool bridge, so
the two paths give the same key. The bridge refuses an agent call id already
used in the session. A call with no id — a tool a step runs with no call
(`invokeTool`), or an agent call the agent neither named over MCP nor
announced — takes `derived-<digest>` of the step's ledger path and the call's
order among the step's calls, so two equal calls get two keys and a resumed
step, making its calls in the same order, gets the same ones. Operations a profile marks `once` —
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
| `replayPrefix: 'unsafe'` | Stop with `connection_resume_refused` until `harness.restore(id, { rerun: ['app'] })`. |

`rerun` belongs to the context that restore returns: it holds for that
context's run and ends when the run does, including a run that fails before it
executes. A restore that finds nothing grants nothing, and another restore of
the same execution without `rerun` is refused again.

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
