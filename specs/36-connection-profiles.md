# 36 — Connection Profiles

> **Depends On:** `35-connections`, `37-verification`
> **Exports:** `defineProfile`, `defineExtension`, `ref()`, `target()`, `sensitive()`, `blob()`, `receipt()`, `Profile`, `Extension`, `Determinism`; the `ui`, `screen`, `browser`, `app`, `device` and `chat` profiles (`@noetic-tools/profile-*`); `checkConformance` (`@noetic-tools/mcp/conformance`)

---

MCP standardizes how to call a tool. It does not say *which* tools a browser
server offers or what a chat event looks like, so an agent written against one
server breaks on the next. A **profile** fixes that vocabulary for one kind of
thing — its operations, the state worth reading, its events — so any server
that speaks it works with any agent written against it.

A profile is a **floor, not a ceiling.** A server implements the required
parts and may offer anything else as **extensions**: versioned, namespaced
additions an agent can require by name.

## Using a profile

Import it and pass it to `connection()` (spec 35). That is all a workflow
author does with a profile: operations, arguments and results become typed,
documents are checked against it, and verification knows what each part can
prove.

```ts
import { browser } from '@noetic-tools/profile-browser';
const app = connection('app', browser);
```

Each profile is its own package, `@noetic-tools/profile-<name>`, depending only
on `@noetic-tools/types` and the profile it extends.

## Defining a profile

```ts
import { defineProfile, ref, receipt, target } from '@noetic-tools/types';

export const chat = defineProfile({
  name: 'chat',
  version: '1.0.0',
  operations: {
    'chat.reply': {
      description: 'Reply in a thread.',
      input: z.object({ thread: ref('chat.thread'), text: z.string() }),
      output: z.object({ message: ref('chat.message'), receipt: receipt() }),
      eager: true, effects: true, once: true,
    },
  },
  reads: {
    'chat.thread.recent': { schema: RecentMessagesSchema, sense: 'state', look: 'effect' },
  },
  events: {
    'chat.message.created': {
      payload: MessageCreatedSchema,
      arguments: z.object({ thread: ref('chat.thread').optional(), mentionsAgent: z.boolean().optional() }),
      sense: 'state', replay: 'durable', thread: 'thread',
    },
  },
});
```

A profile is data: one definition types steps, validates documents, generates
the JSON Schema, checks servers and drives verification.

| Part | Fields |
|---|---|
| `name`, `version` | One lowercase label; semver. The major is part of its identity: `chat@1`. |
| `extends` | Parent profiles with ranges: `{ ui: ui.range('^1') }`. Their parts are inherited unchanged, and requiring the child requires them. A bare range (`{ ui: '^1' }`) requires the parent without inheriting its parts — the parent's definition is not in hand. |
| `operations` | `{ description, input, output, required?, eager?, effects?, once?, guarded?, sense? }` |
| `reads` | State worth reading: `{ schema, sense, look? }` |
| `events` | `{ payload, arguments?, sense, replay, thread?, required? }` |
| `setup` | What a pool accepts to create a fresh connection (spec 35 § Fresh connections). |
| `determinism` | How connections of this kind may be driven again on resume (§ Writing a server). |

Every part is required unless marked `required: false`. The flags:

| Flag | Meaning |
|---|---|
| `eager` | Shown to the model as its own tool by default. Keep this set small; each eager operation costs tokens every turn. |
| `effects` | Changes something. The output includes a `receipt()`: `{ actionId, cursor }` — the action was sent and when, never whether it worked. |
| `once` | A lasting effect (a post, an install). Servers must honor idempotency keys for it. |
| `guarded` | Destructive. Needs approval unless policy allows it. |
| `sense` | The sense its output, read or event is evidence on (§ Senses). |
| `look` | When a read is shown to the model: `'turn'`, `'effect'` or `'ask'` (spec 35 § Looking). |
| `replay` | Whether a listener can resume an event stream: `'durable'` (across server restarts), `'live'` (for the connection's current life) or `'none'`. |
| `thread` | The payload field that names the event's natural thread, used by triggers. |

Field helpers:

| Helper | Meaning |
|---|---|
| `ref(kind, { volatile?, public? })` | An id this connection hands out. `volatile` refs (elements, windows) die with the screen or the connection's current life; `public` refs (a channel id) can be typed by a person. |
| `target(kind)` | A ref of that kind or a locator string (`'button "Pay"'`), resolved by the server to exactly one thing. |
| `sensitive(schema)` | A field a secret may fill; redacted wherever it is stored or reported. |
| `blob(mimeTypes, { sensitive? })` | Binary content, carried as a blob reference. A `sensitive` blob (a stored session) is stored marked sensitive and never rendered to the model. |
| `receipt()` | The receipt every `effects` operation returns. |

## Senses

A **sense** is where evidence comes from: what a connection can perceive about
the thing it drives. Senses are the evidence channels of the
[Open Verification Protocol](https://github.com/reticlehq/reticle/blob/main/open-verification/SPEC.md)
(OVP §3), renamed in Noetic so they do not collide with `Channel<T>`
(spec 06) or a chat channel; spec 37 translates them back at the OVP boundary.

| Sense | Holds | Summary format | Matcher |
|---|---|---|---|
| `ui` | What is on screen | `role "name"` — `button "Pay"` | A locator: `button "Pay"`, `heading` |
| `net` | Requests and responses | `METHOD /path STATUS` — `POST /api/orders 201` (query omitted; full origin for cross-origin) | Any of method, path, status: `POST /api/orders 201`, `GET /api/*`, `5xx` |
| `log` | Errors and messages | `level message` — `error Uncaught TypeError: x is undefined` | Level, optionally a quoted substring: `error`, `error "TypeError"` |
| `route` | Where the user is | the path — `/checkout/done` | A path, `*` and `**` globs allowed |
| `state` | Application state | `store.path` — `cart.items` (value carried separately) | A path, optionally `= value` |
| `signal` | Events the application announces | the signal name — `order.placed` | A name |
| `storage` | Values that outlive a screen | `kind key` — `local session` | Kind and key |
| `time` | What settled and what is in flight | `settled` / `in-flight NAME` | A word |
| `visual` | Pixels | `capture` | — |

Servers produce summaries in exactly these formats, so a matcher written
against the table means the same thing on every server. A matcher with no
wildcard lowers to OVP's exact `summary` match; one with a wildcard or a
status class is evaluated by Noetic as an implementation predicate (OVP
§4 allows this) and still names its sense. Senses outside the table are
prefixed `x-` and documented by their profile.

## Extensions

```ts
export const slackBlocks = defineExtension({
  id: 'com.slack.blocks',
  version: '3.0.0',
  requires: { chat: '^1' },
  operations: {
    'com.slack.blocks.post': { input: BlocksPostSchema, output: z.object({ message: ref('chat.message'), receipt: receipt() }), effects: true, once: true },
  },
  extend: {
    'chat.post':            { input: z.object({ unfurlLinks: z.boolean().optional() }) },
    'chat.message.created': { payload: z.object({ blocks: z.array(BlockSchema).optional() }) },
  },
});
```

- **Ids** are a reverse domain the vendor controls plus a name, at least three
  labels, so they cannot clash with a profile. Everything an extension adds is
  named under its id.
- **`extend`** adds optional fields to profile operations and events, always
  under `ext["<extension id>"]`, so extensions never collide with each other or
  with a later profile version, and code using only the profile is unaffected.
- An extension can never change a profile schema or make an optional part
  required. Extensions version independently, by the rules below.

## Versioning

| Change | Version |
|---|---|
| A fix to a description | patch |
| A new optional operation, read, event, field or argument | minor |
| Anything removed, renamed, narrowed or made required; a weaker `replay`; a changed sense or determinism | major |

A new major is a new identity. A connection implements one major of a profile.

## Catalog v1

★ eager · ○ optional. Every operation with effects returns a `receipt` besides
what is shown. Timeouts are milliseconds.

### `ui@1` — acting on what an interface is

The base of `browser`, `app` and `device`. Operations take an optional
`within` ref (a tab, a window) to scope them; `element` fields are `target()`s.

| Operation | Input → Output | |
|---|---|---|
| `ui.find` | `{ query, within? }` → `{ elements: [{ element: ref, role, name, text? }] }` (sense `ui`) | ★ |
| `ui.describe` | `{ element? \| within?, full? }` → the accessibility tree with refs (sense `ui`) | ★ |
| `ui.tap` | `{ element, count? }` (effects) | ★ |
| `ui.fill` | `{ element, text: sensitive }` — replaces the value (effects) | ★ |
| `ui.type` | `{ element, text: sensitive }` — appends (effects) | |
| `ui.key` | `{ key, modifiers?, element? }` (effects) | |
| `ui.scroll` | `{ element? \| within?, direction, amount? }` (effects) | |
| `ui.select` · `ui.check` · `ui.hover` · `ui.drag` · `ui.upload` | the usual arguments (effects) | ○ |
| `ui.settle` | `{ until: 'quiet' \| 'event', event?, quietMs?, after?: receipt, timeoutMs }` → `{ closedBy: 'quiescence' \| 'signal' \| 'budget-exhausted', unmeasurable? }` (sense `time`) | ★ |

`closedBy` values are OVP close conditions. When a settle cannot measure
quiet — a hidden tab never paints — it waits `quietMs` with no events, returns
`closedBy: 'quiescence'` with `unmeasurable: true`, and never reports a timeout
for that reason. Reads: `ui.summary` (focused element and counts; `look:
'turn'`), `ui.tree` (`'effect'`). Events ○: `ui.changed`. Element refs are
volatile.

### `screen@1` — pixels

For surfaces with no structure (games, canvases, remote desktops), and as an
optional companion to `ui@1`.

| Operation | Input → Output | |
|---|---|---|
| `screen.capture` | `{ within?, region? }` → `{ frame: ref, image: blob, width, height }` (sense `visual`) | |
| `screen.tap` | `{ frame, x, y, count? }` (effects) | |
| `screen.drag` | `{ frame, path: [{ x, y, dtMs? }] }` (effects) | ○ |

Coordinates are pixels of the capture whose `frame` they carry; a server
refuses a frame that no longer matches the screen with `stale_reference`
instead of tapping something that moved. Reads: `screen.current` (`look:
'ask'`).

### `browser@1` (extends `ui@^1`)

| Operation | Input → Output | |
|---|---|---|
| `browser.navigate` | `{ url, tab? }` → `{ url, title }` (effects) | ★ |
| `browser.back` · `forward` · `reload` | `{ tab? }` → `{ url }` (effects) | |
| `browser.tabs` | `{}` → `{ tabs: [{ tab: ref, url, title, active }] }` | |
| `browser.tab.open` · `close` · `select` | `{ url? \| tab }` → `{ tab: ref }` (effects) | |
| `browser.dialog.respond` | `{ dialog: ref, accept, text? }` (effects) | |
| `browser.requests` | `{ since?, actionId?, filter? }` → `{ requests: [{ summary, method, url, status, timing }] }` (sense `net`) | ○ |
| `browser.console` | `{ since?, actionId?, level? }` → `{ messages }` (sense `log`) | ○ |
| `browser.state` | `{ path? }` → `{ value }` (sense `state`; from an SDK inside the app) | ○ |
| `browser.evaluate` | `{ expression, tab? }` → `{ value }` (guarded) | ○ |

Reads: `browser.page.summary` (url, title, route; `'turn'`), `browser.page`
(`'effect'`). Events, all `replay: 'live'` with an `actionId` argument:
`browser.page.loaded` (sense `route`), `browser.dialog.opened` (sense `ui`),
and ○ `browser.request` (`net`), `browser.console.message` (`log`),
`browser.signal` (`signal`), `browser.download` (`x-artifact`, carries a
blob). Setup: `{ url?, session?: blob (sensitive), viewport?, locale?, timezone? }`.

A browser server reaches OVP's `effect` level with `net` and `log`,
`in-realm` adding `state` and `signal`, and `surface` adding `ui`.

### `app@1` (extends `ui@^1`) — desktop applications

| Operation | Input → Output | |
|---|---|---|
| `app.launch` | `{}` → `{ app: ref }` — the app this connection was set up for (effects) | ○ ★ |
| `app.attach` | `{ match? }` → `{ app: ref }` — an app already running | ○ |
| `app.windows` | `{ app? }` → `{ windows: [{ window: ref, title, focused }] }` | ★ |
| `app.window.focus` | `{ window }` (effects) | |
| `app.terminate` | `{ app }` (effects) | |
| `app.state` | `{ path? }` → `{ value }` (sense `state`) | ○ |

A server offers `app.launch`, `app.attach` or both. Reads: `app.summary`
(`'turn'`). Events: `app.exited` (sense `x-exit`: the app's own exit code) and
`app.terminated` (sense `x-termination`: ended by the operating system or a
supervisor) — separate senses because one is the app describing itself and the
other is not (OVP-CHAN-5); ○ `app.signal` (`signal`). Window refs are
volatile. Setup: `{ path | command, args?, env? }`, with `path`, `command`
and `env` reserved to the host.

### `device@1` (extends `ui@^1`) — simulators, emulators, phones

| Operation | Input → Output | |
|---|---|---|
| `device.info` | `{}` → `{ platform, osVersion, model, orientation, buttons }` | ★ |
| `device.app.install` | `{ path }` → `{ app: ref }` (effects, once) | |
| `device.app.launch` | `{ app \| bundleId }` → `{ app: ref }` (effects) | ★ |
| `device.app.terminate` | `{ app }` (effects) | |
| `device.openUrl` | `{ url }` (effects) | |
| `device.button` | `{ name }` — one of `device.info.buttons`, else `unsupported` (effects) | |
| `device.rotate` · `device.appearance` | (effects) | ○ |
| `device.logs` | `{ app?, since? }` → `{ lines }` (sense `log`) | ○ |
| `device.test.run` | `{ plan }` → `{ passed, failed, report: blob }` (effects, once) | ○ |

Reads: `device.summary` (`'turn'`). Events: `device.app.crashed` (sense
`log`, `replay: 'durable'`). Setup: `{ model?, osVersion? }`.
Platform-specific features — permission dialogs, intents — are extensions.

### `chat@1` — messaging workspaces

For agents that start conversations and wait on people. A bot that answers
every message belongs on `@noetic-tools/chat-sdk` (spec 29).

| Operation | Input → Output | |
|---|---|---|
| `chat.post` | `{ channel: ref, text }` → `{ message: ref, thread: ref }` (effects, once) | ★ |
| `chat.reply` | `{ thread, text }` → `{ message: ref }` (effects, once) | ★ |
| `chat.history` | `{ channel? \| thread?, cursor?, limit? }` → `{ messages, cursor? }` (sense `state`) | ★ |
| `chat.channels` | `{ cursor? }` → `{ channels: [{ channel: ref, name }], cursor? }` | |
| `chat.react` · `chat.edit` · `chat.delete` (guarded) · `chat.users` | | ○ |

Text is CommonMark. `chat.channel` and `chat.user` refs are public. Reads:
`chat.thread.recent` (`'effect'`). Events, sense `state`, `replay: 'durable'`,
`thread: 'thread'`: `chat.message.created` (arguments `channel?`, `thread?`,
`mentionsAgent?`), and ○ `chat.message.updated`, `chat.reaction.added`.
Identity surface: `x-chat`.

---

## Writing a server

The rest of this spec is for people implementing a profile.

### Declaring a server

A server declares what it implements under `tools.noetic/profiles` in its MCP
`extensions` capability:

```json
{
  "tools.noetic/profiles": {
    "profiles": { "browser": "1.2.0", "ui": "1.1.0" },
    "extensions": { "com.example.probe": "1.0.0" },
    "senses": {
      "ui":  { "independence": "actuation-derived", "grade": "presence" },
      "net": { "independence": "independent", "grade": "consequence" },
      "log": { "independence": "independent", "grade": "context" }
    },
    "determinism": { "reset": "cheap", "replayPrefix": "free", "time": "wall", "observation": "exact", "actions": "reversible" },
    "setup": { "$ref": "#/setup" },
    "aliases": { "ui.find": { "tool": "probe_look", "fixed": { "action": "find" } } },
    "instances": [{ "id": "ctx-1", "title": "Chromium · localhost:5173" }]
  }
}
```

- **Profiles** — each with every parent, inside the child's range.
- **Senses** — OVP channel descriptors: each sense's independence and grade.
  Defaults are OVP's table; a server may declare a sense less trustworthy,
  never more (OVP-CHAN-1). `x-` senses must declare both.
- **Determinism** — OVP's determinism profile (OVP §10.4) as a `Determinism`.
  A profile sets a default — a browser `{ reset: 'cheap', replayPrefix: 'free',
  time: 'wall', … }`, chat `{ reset: 'none', replayPrefix: 'unsafe', …,
  actions: 'irreversible' }` — and a server may declare itself less forgiving,
  never more.
- **Aliases** — by default an operation's MCP tool has the operation's name.
  An alias maps it onto a tool the server already has, with fixed arguments
  merged in, so an existing server can implement a profile without a second
  tool surface.
- **Instances** — when one server serves several connections, requests carry
  `_meta["tools.noetic/instance"]`.
- Names use only letters, digits, `_`, `-` and `.`, as MCP tool names require.

### Parts every server provides

| Part | Purpose |
|---|---|
| `noetic://identity` and the `identity.changed` event | OVP subject `{ surface, instance, epoch? }`. `instance` changes whenever the thing is replaced and is never constant (OVP-SUBJ-1); `epoch` is a non-negative integer that moves on code edits, absent when edits cannot be seen. |
| `noetic.reset` | When `determinism.reset` is not `none`. |
| `noetic.provision` · `noetic.release` | When the server can back a pool. |
| `noetic://coverage?since=<cursor>` | Optional. OVP blind spots since a cursor, each naming its sense; a sense whose blind spots cannot be listed is left out (OVP-EVID-2). |
| `noetic.detect({ since })` | Optional. OVP anomalies with their tier, set honestly (OVP-REALITY-3). |

### Receipts and idempotency

Every `effects` operation returns a receipt and attributes the events it causes
to its `actionId`. It never reports whether it worked (OVP-REALITY-2). Every
`once` operation returns its original outcome for a repeated
`_meta["tools.noetic/idempotency-key"]` for at least 24 hours, and refuses the
same key with different arguments with `conflict`.

### Errors

A refused or failed operation returns an MCP tool error with
`structuredContent: { code, message, details? }`:

| Code | Meaning |
|---|---|
| `undeclared` | Not an operation of this connection. |
| `unsupported` | This connection cannot honestly do it for this target. |
| `unresolved` | The target could not be found. |
| `ambiguous` | A locator matched several targets; `details.candidates` lists them. Never pick one (OVP-REALITY-4). |
| `unavailable` | Found, but not in a state to accept this. |
| `guarded` | Refused on purpose. The harness asks for approval and retries with `_meta["tools.noetic/confirmed"]`, which only it can set. |
| `malformed` | Bad arguments. Never substitute a default. |
| `stale_reference` | A volatile ref no longer resolves. |
| `not_found` · `permission_denied` · `rate_limited` · `busy` · `conflict` | As named. |

A server never approximates: what it cannot do exactly, it refuses.

### Conformance

`checkConformance({ server, profile, extensions, driver })` runs the profile's
scenarios against a server. A **driver** written by the server's author causes
what the server cannot — another user's message, a crash, a failing request.

- The declaration is checked first, against what the server actually serves.
- Every `effects` operation is confirmed through an independent sense; a server
  whose receipts describe actions that never happened fails.
- One scenario is a healthy subject with a real claim and must be proved
  `yes` (OVP-CONF-2), so a server cannot pass by answering "unknown".
- Ambiguous locators must be refused, sensitive fields masked on screen,
  summaries produced in the § Senses formats, identity changed on replacement.
- A scenario the driver cannot set up scores `absent`, never a pass.

The report names each failure with the profile part it comes from, and the OVP
conformance level the declared senses reach.

## Future Considerations

- Fixtures: saved starting state (a signed-in session, a seeded simulator)
  applied after setup.
- Clock control for servers that can freeze and advance time.
- Alias result projections and per-instance declarations.
- More profiles: `email`, `calendar`, `issues`, `service`, `game`.
- Reference servers for each v1 profile.
