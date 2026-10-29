# 36 — Connection Profiles

> **Depends On:** `35-connections` (Connection, ConnectionEvent, ConnectionReference, Receipt, BlobReference), `37-verification` (channels)
> **Exports:** `defineProfile`, `defineExtension`, `Profile`, `Extension`, `ProfileOperation`, `ProfileEvent`, `ProfileResource`, `reference()`, `sensitive()`, `receipt()`, `blob()`; the `ui`, `screen`, `browser`, `app`, `device` and `chat` profiles (`@noetic-tools/profile-*`); `checkConformance` (`@noetic-tools/profile-conformance`)

---

MCP standardizes how a client calls a tool, reads a resource, runs a task and
receives an event. It does not standardize *which* tools a browser server
offers or what a chat event looks like, so an agent written against one server
breaks on the next. A **profile** fixes that vocabulary for one kind of
surface: operation names and schemas, resources, event types with their
arguments and payloads, and how each part behaves under resume and
verification. Any MCP server that implements a profile works with any agent
written against it.

A profile is a **floor, not a ceiling.** A conforming server implements all of
the profile's required parts and may offer anything else as **extensions** —
versioned, namespaced additions that agents can require explicitly. Profiles
stay small and portable; extensions keep each platform fully usable.

Profiles borrow their model of evidence from the
[Open Verification Protocol](https://github.com/reticlehq/reticle/blob/main/open-verification/SPEC.md)
(OVP v1): every part declares the OVP channel it observes through, every server
declares its subject identity and determinism, actions return receipts and never
verdicts, and nothing is approximated. A conforming server is therefore a
usable OVP realm (spec 37). Where this spec says "conformance level", it means
OVP's `effect`, `in-realm` and `surface` (OVP §10); "profile" always means a
profile in this spec.

## Defining a profile

```ts
import { defineProfile, reference, receipt, sensitive } from '@noetic-tools/types';
import { z } from 'zod';

export const chat = defineProfile({
  name: 'chat',
  version: '1.0.0',
  operations: {
    'chat.reply': {
      description: 'Reply in a thread.',
      input: z.object({ thread: reference('chat.thread'), text: z.string(), attachments: z.array(AttachmentSchema).optional() }),
      output: z.object({ message: reference('chat.message'), receipt: receipt() }),
      required: true,
      core: true,
      effects: true,
      idempotency: 'required',
      channel: 'net',
    },
  },
  resources: {
    'chat.thread.recent': { uri: 'chat://threads/{thread}/recent', schema: RecentMessagesSchema, channel: 'state', observe: { mode: 'on-change', detail: 'summary' } },
  },
  events: {
    'chat.message.created': {
      arguments: z.object({ channel: reference('chat.channel').optional(), thread: reference('chat.thread').optional(), mentionsAgent: z.boolean().optional() }),
      payload: MessageCreatedSchema,
      channel: 'net',
      replay: 'durable',
      required: true,
    },
  },
});
```

A profile is data: `defineProfile` validates the definition and returns a
frozen `Profile` whose types flow into `step.connectionCall` and whose schemas
drive JSON validation, the generated JSON Schema, negotiation, verification and
conformance.

| Part | Fields |
|---|---|
| `name` | One lowercase label, `[a-z][a-z0-9-]*`. |
| `version` | Semver. The major is part of the profile's identity (`chat@1`). |
| `extends` | Parent profiles with ranges, e.g. `{ ui: '^1.1' }`. Their parts are inherited unchanged. |
| `operations` | Name → `{ description, input, output, required, core, effects, idempotency, guarded, task, channel }`. |
| `resources` | Name → `{ uri, schema, channel, observe, summary? }`. |
| `events` | Event type → `{ arguments, payload, channel, replay, required }`. |
| `determinism` | The default determinism profile for instances of this profile (§ Determinism). |
| `provisioning` | The schema of a `ProvisionRequest.spec` for pools serving this profile (§ Provisioning). |

### Inheritance

`extends` names each parent with a semver range. A server declaring a child
profile must also declare each parent at a version inside the range the
child's declared version gives for it, and a slot requiring the child
implicitly requires those parent ranges. Inherited operations are therefore
versioned through their child.

### Operations

- **`required`** — a conforming server implements it. **`core`** — exposed to
  the model by default (`35-connections` § Model-facing tools); keep this set
  small, because every core operation costs schema tokens on every turn.
- **`effects`** — the operation changes something. Its output must include a
  `receipt` (§ Receipts).
- **`idempotency`** — `'required'` for lasting upstream effects (a server must
  honor idempotency keys, § Idempotency); `'none'` for effects local to the
  instance's current state, such as gestures, whose resume safety comes from
  determinism.
- **`guarded`** — destructive or irreversible; the harness requires approval
  unless policy allows it (`35-connections` § The gate chain). A server may
  also guard a call per target — a "Delete account" button — by refusing it
  with `guarded` (§ Operation errors).
- **`task`** — `'never'`, `'may'` (default) or `'always'`; a conformance
  assertion about the server's own decision to return a task (SEP-2663).
- **`channel`** — the OVP channel the operation's *output* is evidence on.
  Required for every operation that returns observations (`ui.find` → `ui`,
  `browser.network.list` → `net`); an operation whose only output is a receipt
  or a reference names none.
- Names use only letters, digits, `_`, `-` and `.` — the characters MCP allows
  in tool names — as `<profile>.<verb>` or `<profile>.<noun>.<verb>`.

### Resources

- **`channel`** — the OVP channel the resource observes.
- **`observe`** — the default observation policy (`35-connections`
  § Observations): `mode` and `detail`. Every profile with a screen or a tree
  must provide a cheap summary resource with mode `every-turn`, and must make
  image resources `on-demand`.
- **`summary`** — an optional projection of the resource for `detail:
  'summary'`, so one resource can serve both a 25-token check and a full read.

### Events

- **`channel`** — the OVP channel the event is evidence on.
- **`arguments`** — the subscription arguments schema (SEP-3415 `inputSchema`),
  so profiles standardize server-side filters, not just payloads. Every event
  type an `effects` operation can cause accepts an optional `actionId` argument.
- **`replay`** — `'durable'` (cursors survive server restarts), `'session'`
  (cursors valid for the instance's current identity, served from a bounded
  buffer the server keeps and reports truncation from), or `'none'`.

### Receipts

`receipt()` is the schema of `{ actionId, cursor, dispatched: true }`. Every
`effects` operation returns one: the action was delivered, here is its id, and
here is where the instance's event streams stood. A receipt never reports
whether the action worked — a server that reported its own success would be
the thing under test grading its own work (OVP-REALITY-2). Events the server
attributes to the action carry its `actionId`.

### References

`reference(kind, opts)` marks a field as an id that only means something on the
instance that issued it. On the wire it is a plain string; the harness wraps
it as a `ConnectionReference` (`35-connections` § References).

| Option | Meaning |
|---|---|
| `lifetime: 'durable'` (default) | Lives as long as the upstream object: a thread, a message, an installed app, a task. |
| `lifetime: 'volatile'` | Lives at most as long as the instance identity, often less: an element in a UI tree, a window, a frame. |
| `public: true` | A person can know it without the harness issuing it: a channel id, a URL. |

Kinds are namespaced by the profile that defines them. `task` and
`connection` (a lease) are built in.

### Sensitive fields and blobs

`sensitive(schema)` marks an input field the harness redacts wherever it
persists or reports it, and the only kind of field a `$secret` value may fill
(`35-connections` § Secrets): passwords, tokens, payment details typed into a
form. Blobs holding credentials — a browser's `storageState`, a fixture — are
sensitive by default. `blob(mimeTypes)` marks a field carrying binary
content; on the wire it is an MCP content block, in Noetic a `BlobReference`.

### Operation errors

An operation that fails or is refused returns an MCP tool error whose
`structuredContent` carries `{ code, message, details? }`. The codes include
OVP's refusal reasons (OVP §5) and are shared by every profile:

| Code | Meaning |
|---|---|
| `undeclared` | The operation is not declared by this instance. |
| `unsupported` | Declared, and this instance cannot honestly do it for this target, e.g. a button the device lacks. |
| `unresolved` | The target could not be found. |
| `ambiguous` | A description matched several targets; `details.candidates` lists them. A server must never choose among them (OVP-REALITY-4). |
| `unavailable` | Found, and not in a state that can accept this. |
| `guarded` | Refused on purpose: destructive and not confirmed. The harness routes it to approval and, once approved, retries with `_meta["tools.noetic/confirmed"]` set. Only the harness sets that key; a `confirm` argument from a model or document is stripped, and the approver is recorded in the ledger. |
| `malformed` | The arguments were malformed. A server must not substitute a default and proceed. |
| `stale_reference` | A volatile reference no longer resolves. |
| `not_found` | A referenced durable object no longer exists. |
| `permission_denied` | The upstream refused the caller. |
| `rate_limited` | The upstream throttled the call; `details.retryAfterMs` when known. |
| `busy` | The instance is occupied, e.g. a device mid-install. |
| `conflict` | An idempotency key was reused with different arguments. |

A server must never approximate: an action it cannot perform exactly as asked
is refused with one of these codes, never performed on something adjacent.

### Idempotency

Every call carries `_meta["tools.noetic/idempotency-key"]`
(`35-connections` § Durability). For an operation with `idempotency:
'required'`, a server that receives a key it has already seen with the same
arguments returns the original outcome — the same result, or the same task —
without repeating the effect, for at least 24 hours. The same key with
different arguments fails with `conflict`. Operations with `idempotency:
'none'` may ignore the key.

## Universal parts

Every conforming server, whatever its profiles, provides these.

### Identity

The resource `noetic://identity` returns the instance's OVP subject
`{ surface, instance, epoch? }` (`35-connections` § The contract) — `surface`
one of OVP's named surfaces or an `x-` surface (`x-chat`), `epoch` a
non-negative integer — and the event `identity.changed` (replay `none`) fires
when either moves. `instance`
must change whenever the thing it names is replaced and must never be constant
(OVP-SUBJ-1); `epoch` moves when the code changes without the instance being
replaced, and is absent — not zero — when the server cannot observe edits
(OVP §2).

### Determinism

Every instance declares how it may be driven, using OVP's determinism profile
(OVP §10.4) verbatim:

```ts
interface DeterminismProfile {
  reset: 'none' | 'cheap' | 'costly';
  replayPrefix: 'free' | 'costly' | 'unsafe';
  time: 'wall' | 'injectable' | 'stepped';
  observation: 'exact' | 'sampled';
  actions: 'reversible' | 'irreversible';
}
```

A profile states a default (a browser context: `{ reset: 'cheap', replayPrefix:
'free', time: 'wall', observation: 'exact', actions: 'reversible' }`;
chat: `{ reset: 'none', replayPrefix: 'unsafe', … actions: 'irreversible' }`),
and a server may declare its instances *less* forgiving, never more. The harness
derives its resume strategy from it (`35-connections` § Resume against a
changed instance). A server whose `reset` is not `none` implements the tool
`noetic.reset`. A server declaring `time: 'injectable'` implements
`noetic.clock.freeze({ at })` and `noetic.clock.advance({ ms })`; one that
cannot declares `time: 'wall'`. Declaring a property the server does not have
fails conformance.

### Channels

A server declares, per instance, the OVP channels it can observe as OVP
channel descriptors — each with its `independence` (`independent` or
`actuation-derived`) and `grade` (`consequence`, `presence` or `context`) —
defaulting to OVP's table (OVP §3). It may declare a channel less trustworthy
than that table, never more (OVP-CHAN-1). Channels outside OVP's table are
prefixed `x-` and must declare both truthfully; the catalog below gives each
`x-` channel it uses a fixed descriptor. Every operation output, resource and
event names one declared channel. Verification reads this declaration
(spec 37); a server whose operations report on a channel it did not declare
fails conformance.

### Coverage

A server that can enumerate what it could not see implements the resource
`noetic://coverage?window=<cursor>&actionId=<id>`, returning OVP blind spots
for the stretch from that cursor, each naming the channel it falls on. A server
that cannot enumerate them for a channel omits the channel rather than
returning an empty list (OVP-EVID-2). It never judges relevance to a claim;
that is the adjudicator's (OVP-EVID-1).

### Anomaly detection

Optional, after OVP's `detect`. A server that knows what its requests and
renders are implements `noetic.detect({ since, actionId? })`, returning OVP
anomalies with their `kind`, `tier` and the two channels `between` which they
fall. It sets the tier honestly, and reports `absence-derived` when it cannot
tell (OVP-REALITY-3). A disagreement it reports convicts only if one of its
channels is independent, which the adjudicator checks.

### Provisioning

A server that can create instances on demand declares a provisioning schema,
the union of its profiles' `provisioning` schemas — a browser context takes
`{ url?, storageState?: blob, viewport?, locale?, timezone? }`, an app
`{ path | command, args?, env? }`, a device `{ model?, osVersion? }` — and
implements `noetic.provision` and `noetic.release` as tools. The
MCP bridge maps them onto `ConnectionProvider.provision` and
`Connection.release`. Fields that choose what runs on the host — an app's
`path`, `command` and `env` — are marked `hostOnly`: they come only from the
pool's configuration, never from a workflow (`35-connections` § Pools and
leases).

### Fixtures

Optional, after OVP §10.3. `fixture.capture` returns a `BlobReference` holding
the state needed to start from — a browser's storage state, a simulator
snapshot, seeded rows — tagged with the identity it was captured from;
`fixture.apply` restores one. A fixture captured under a different epoch is
refused with `unavailable`. Slots may name a fixture to apply after
provisioning and after a reset. A fixture is usable on any instance with the
same `surface` and `epoch` — deliberately looser than OVP's `fixtureIsUsable`,
which also requires the same `instance` and would make fixtures unusable on
fresh leases (`37-verification` § Deviations).

## Extensions

```ts
import { defineExtension } from '@noetic-tools/types';

export const slackBlocks = defineExtension({
  id: 'com.slack.blocks',
  version: '3.0.0',
  requires: { chat: '^1' },
  operations: {
    'com.slack.blocks.post': { input: BlocksPostSchema, output: z.object({ message: reference('chat.message'), receipt: receipt() }), effects: true, idempotency: 'required', channel: 'net' },
  },
  events: {
    'com.slack.blocks.action': { arguments: BlockActionFilterSchema, payload: BlockActionSchema, channel: 'net', replay: 'durable' },
  },
  inputExt: {
    'chat.post': z.object({ unfurlLinks: z.boolean().optional() }),
  },
  payloadExt: {
    'chat.message.created': z.object({ blocks: z.array(BlockSchema).optional() }),
  },
});
```

- **Ids** are a reverse domain the vendor controls followed by a name, at least
  three labels, so no extension id can equal a profile name. Every operation,
  event type and resource an extension adds starts with its id.
- **`requires`** names the profile ranges the extension builds on. An extension
  with no `requires` stands alone; triggers are extensions of this kind.
- Extensions are versioned independently, by the same rules (§ Versioning).

### Adding fields

An extension may add fields to profile operations and events, always under its
own id:

| Declared as | Lands at |
|---|---|
| `inputExt` (optional fields only) | `args.ext["<extension id>"]` |
| `outputExt` | `result.ext["<extension id>"]` |
| `payloadExt` | `payload.ext["<extension id>"]` |

A caller or consumer using only the profile's fields is unaffected. An
extension can never change a profile schema, make an optional part required, or
remove anything.

## Versioning

Profiles and extensions follow semver, judged from the consumer's side:

| Change | Version |
|---|---|
| Fix a description, tighten documentation | patch |
| Add an optional operation, event type, resource, input field, output field or event argument | minor |
| Make an optional part required, remove or rename anything, narrow an input, widen an output enum, weaken `replay`, change a channel or its descriptor, or change a determinism default | major |

A new major is a new identity: `chat@2`'s operations are distinct from
`chat@1`'s even where names match. An instance implements one major of a
profile; a server serving several majors does so as separate instances.

## Wire declaration

A server declares conformance under the `tools.noetic/profiles` key of its MCP
`extensions` capability, read during capability discovery:

```json
{
  "capabilities": {
    "extensions": {
      "io.modelcontextprotocol/tasks": {},
      "io.modelcontextprotocol/events": {},
      "tools.noetic/profiles": {
        "profiles": { "browser": "1.2.0", "ui": "1.1.0" },
        "extensions": { "com.example.probe": "1.0.0" },
        "channels": {
          "ui":    { "independence": "actuation-derived", "grade": "presence" },
          "net":   { "independence": "independent", "grade": "consequence" },
          "log":   { "independence": "independent", "grade": "context" },
          "state": { "independence": "actuation-derived", "grade": "consequence" },
          "time":  { "independence": "independent", "grade": "context" }
        },
        "determinism": { "reset": "cheap", "replayPrefix": "free", "time": "wall", "observation": "exact", "actions": "reversible" },
        "provisioning": { "$ref": "#/provisioning" },
        "aliases": {
          "ui.find":       { "tool": "probe_look", "fixed": { "action": "find" } },
          "browser.text":  { "tool": "probe_look", "fixed": { "action": "page" }, "result": "{ 'text': content }" },
          "ui.settle":     { "tool": "probe_wait", "fixed": { "mode": "settle" } }
        },
        "instances": [
          { "id": "ctx-1", "title": "Chromium · localhost:5173" }
        ]
      }
    }
  }
}
```

- **Profiles and parents.** Every parent of a declared profile is declared too,
  inside the child's range.
- **Aliases.** By default an operation's MCP tool name is the operation name.
  `aliases` maps an operation onto a tool the server already has, with
  `fixed` arguments merged into every call and an optional `result` JSONata
  projection from the tool's output to the operation's output schema. An
  existing server can therefore claim a profile without adding a second tool
  surface. The projection comes from the server, so it is untrusted: core's
  connection registry evaluates it under fixed expression limits
  (`33-expressions`), with the tool's output as its only input, and validates
  the projected value against the operation's output schema on every call.
  Negotiation validates input schemas through aliases; outputs are validated
  per call.
- **Instances.** `instances` is present when one server serves several
  instances. An entry's `profiles`, `extensions`, `channels` and `determinism`,
  when present, replace the server-level ones for that instance. Requests to
  such a server carry `_meta["tools.noetic/instance"]`. The list may change;
  the server sends `notifications/tools/list_changed` with
  `_meta["tools.noetic/instances-changed"]: true`.
- Event types are the server's SEP-3415 event names and resources its resource
  template names, verbatim. Anything outside the declaration is still usable as
  an ordinary MCP tool, but no workflow can require it.

## Conformance

Each profile package ships behavioral conformance scenarios, after OVP's
conformance rules (OVP §10): scenarios set up a situation on the server, act,
and check what an independent observation shows, not only the shapes returned.
A **driver** the server author supplies causes what the server cannot: a
message posted by another user, a crashed app, a failing request.

```ts
const report = await checkConformance({
  server: { command: 'playwright-mcp', args: [] },
  profile: browser,
  extensions: [],
  driver: playwrightConformanceDriver,
});
```

- **The declaration is the first assertion.** The wire declaration — profiles,
  parents, channels, determinism, aliases, provisioning — must match what the
  server actually serves (OVP-CONF-3).
- **A scenario that could not be set up is scored `absent`, never a pass.** A
  driver that refuses a scenario reduces coverage visibly; it cannot raise the
  score.
- **Effect controls are mandatory.** For every `effects` operation, a
  scenario acts and confirms the effect through an independent channel — a tap
  on a button that issues a request is confirmed on `net`, a `chat.post` by
  reading the message back through the driver. A server that returns receipts
  for actions that never happened fails.
- **The negative control is mandatory** (OVP-CONF-2): one scenario is a
  healthy subject with a real claim, verified end to end, and must come back
  `yes`. A server that makes everything `unknown` cannot pass.
- **Refusal scenarios.** Ambiguous descriptions must return `ambiguous` with
  candidates; undeclared operations `undeclared`; malformed arguments
  `malformed`. A server that approximates fails.
- **Also checked:** schemas through aliases, operation error shapes, `task`
  assertions, idempotency on `'required'` operations, identity changes on
  replacement (and never a constant `instance`), `replay` behavior per event
  type, reference lifetimes, provisioning and release, and per-instance
  routing.
- The report names each failed or absent requirement with the profile part it
  comes from, and the OVP conformance level the server's declared channels
  reach, computed with OVP's `profileFromChannels`.

## Graduation

When several servers ship extensions that do the same thing, it becomes part of
the profile: first optional in a minor version, later — if universal — required
in the next major. The extensions stay valid for agents that require them.

## Catalog v1

Each profile below is its own package, `@noetic-tools/profile-<name>`. ● is
required, ○ optional, ★ core (exposed to the model by default). Every operation
marked with effects returns a `receipt` in addition to the output shown.

### `ui@1` — semantic interaction

Acting on what an interface *is*: elements found by role, name and text, acted
on by reference. The base of `browser`, `app` and `device`, and the only UI
vocabulary a server that does not take screenshots needs.

Every operation takes an optional `within` reference (a `browser.tab`, an
`app.window`) to scope it. Element references are volatile.

| Operation | Input → Output | |
|---|---|---|
| `ui.find` | `{ query, within? }` → `{ elements: [{ element: ref, role, name, text?, bounds? }] }` (channel `ui`) | ● ★ |
| `ui.describe` | `{ element? \| within?, detail: 'summary' \| 'full' }` → the accessibility tree with element refs (channel `ui`) | ● ★ |
| `ui.tap` | `{ element, count? }` → `{}` (a click on pointer devices; effects) | ● ★ |
| `ui.type` | `{ element, text: sensitive? }` → `{}` (appends; effects) | ● ★ |
| `ui.fill` | `{ element, text: sensitive? }` → `{}` (replaces; effects) | ● ★ |
| `ui.key` | `{ key, modifiers?, element? }` → `{}` (effects) | ● |
| `ui.scroll` | `{ element? \| within?, direction, amount? }` → `{}` (effects) | ● |
| `ui.select` | `{ element, values }` → `{}` (effects) | ○ |
| `ui.check` | `{ element, checked }` → `{}` (effects) | ○ |
| `ui.hover` | `{ element }` → `{}` (effects) | ○ |
| `ui.upload` | `{ element, files: blob[] }` → `{}` (effects) | ○ |
| `ui.drag` | `{ from: element, to: element }` → `{}` (effects) | ○ |
| `ui.settle` | `{ until: 'quiet' \| 'signal', quietMs?, signal?, after?: receipt, timeoutMs }` → `{ closedBy: 'quiescence' \| 'signal' \| 'budget-exhausted', unmeasurable?: true }` (channel `time`) | ● ★ |

`closedBy` values are OVP close conditions. When `ui.settle` cannot read its
condition — a hidden browser tab never flushes the frame quiescence is read
from — it waits `quietMs` with no event on the instance, returns
`closedBy: 'quiescence'` with `unmeasurable: true`, and never reports a
timeout for this reason (OVP-REALITY-6). A page load is `until: 'signal'`
with `signal: 'browser.page.loaded'`. Resources: `ui.summary` (focused
element, counts by role; `every-turn`) ●, `ui.tree` (`after-effect`, summary
detail) ●. Events (channel `ui`, replay `session`, `actionId` argument):
`ui.changed` ○, `ui.focus.changed` ○. Reference kinds: `ui.element`
(volatile). Determinism default: as a browser context.

### `screen@1` — pixels

Coordinates and captures, for surfaces with no accessible structure (games,
canvases, remote desktops) and as an optional companion to `ui@1`.

| Operation | Input → Output | |
|---|---|---|
| `screen.capture` | `{ within?, region? }` → `{ frame: ref, image: blob, width, height }` (channel `visual`) | ● |
| `screen.tap` | `{ frame, x, y, count? }` → `{}` (effects) | ● |
| `screen.drag` | `{ frame, path: [{ x, y, dtMs? }] }` → `{}` (effects) | ○ |
| `screen.longPress` | `{ frame, x, y, durationMs }` → `{}` (effects) | ○ |
| `screen.compare` | `{ a: blob, b: blob, threshold? }` → `{ diffRatio, diff: blob }` (channel `visual`) | ○ |

Coordinates are in the pixel space of the capture whose `frame` reference they
carry. A `frame` is volatile; a server refuses a frame that no longer matches
what is on screen with `stale_reference` rather than tapping a moved target.
Resources: `screen.current` (`on-demand`, `maxImages: 1`) ●. Reference kinds:
`screen.frame` (volatile).

### `browser@1` (extends `ui@^1`)

| Operation | Input → Output | |
|---|---|---|
| `browser.navigate` | `{ url, tab? }` → `{ url, title }` (effects) | ● ★ |
| `browser.back` / `browser.forward` / `browser.reload` | `{ tab? }` → `{ url }` (effects) | ● |
| `browser.tabs.list` | `{}` → `{ tabs: [{ tab: ref, url, title, active }] }` | ● |
| `browser.tabs.open` / `close` / `select` | `{ url? \| tab }` → `{ tab: ref }` (effects) | ● |
| `browser.dialog.respond` | `{ dialog: ref, accept, text? }` → `{}` (effects) | ● |
| `browser.viewport.set` | `{ width, height, deviceScaleFactor? }` → `{}` (effects) | ○ |
| `browser.network.list` | `{ since?: cursor, actionId?, filter? }` → `{ requests: [{ id, method, url, status, timing, initiator, bodies? }] }` (channel `net`) | ○ |
| `browser.console.list` | `{ since?: cursor, actionId?, level? }` → `{ messages }` (channel `log`) | ○ |
| `browser.storage.read` | `{ kind: 'local' \| 'session' \| 'cookies', keys? }` → `{ values }` (channel `storage`) | ○ |
| `browser.state.read` | `{ store?, path? }` → `{ value }` (channel `state`; application state exposed by an in-app SDK) | ○ |
| `browser.route` | `{ tab? }` → `{ url, route?, params? }` (channel `route`) | ○ |
| `browser.text` | `{ tab? }` → `{ text }` (channel `ui`) | ○ |
| `browser.evaluate` | `{ expression, tab? }` → `{ value }` (guarded) | ○ |

Request and response bodies are returned only when the instance was provisioned
with `captureBodies: true`, and fields the server identifies as credentials are
redacted (a `redacted` blind spot in verification). Resources:
`browser.page.summary` (url, title, route; `every-turn`) ●, `browser.page`
(`after-effect`) ●. Events: `browser.page.loaded` ● (channel `route`),
`browser.dialog.opened` ● (channel `ui`), `browser.network.request` ○ (channel
`net`), `browser.console.message` ○ (channel `log`), `browser.state.changed` ○
(channel `state`), `browser.signal` ○ (channel `signal`: events the
application announces about itself), `browser.download` ○ (channel
`x-artifact`, independence `actuation-derived`, grade `consequence`; payload
carries a blob), `browser.perf` ○ (channel `time`) — all replay `session` with
an `actionId` argument. Reference kinds:
`browser.tab`, `browser.dialog` (volatile). Provisioning: `{ url?,
storageState?: blob, viewport?, locale?, timezone?, captureBodies? }`.

Which OVP conformance level a browser server reaches depends on the optional
parts it implements: `net` and `log` reach `effect`; adding `state` and
`signal` (usually through an SDK inside the application) reaches `in-realm`;
with `ui`, `surface`.

### `app@1` (extends `ui@^1`)

A desktop application — Electron, Tauri, native — with processes and windows.

| Operation | Input → Output | |
|---|---|---|
| `app.launch` | `{}` → `{ app: ref }` — launches the app the instance was provisioned for (effects, idempotency none) | ○ ★ |
| `app.attach` | `{ match? }` → `{ app: ref }` — attaches to an app already running, e.g. one embedding an SDK | ○ |
| `app.terminate` | `{ app }` → `{}` (effects) | ● |
| `app.windows.list` | `{ app? }` → `{ windows: [{ window: ref, title, focused, bounds }] }` | ● ★ |
| `app.windows.focus` | `{ window }` → `{}` (effects) | ● |
| `app.windows.close` | `{ window }` → `{}` (effects) | ○ |
| `app.menu.invoke` | `{ app, path: string[] }` → `{}` (effects) | ○ |
| `app.state.read` | `{ store?, path? }` → `{ value }` (channel `state`) | ○ |

A server implements at least one of `app.launch` and `app.attach`.

Every `ui` and `screen` operation takes `within: window`. Resources:
`app.summary` (running apps, windows, focus; `every-turn`) ●. Events:
`app.exited` ● (channel `x-exit`: actuation-derived, grade `consequence` —
the exit code the app chose) and `app.terminated` ● (channel `x-termination`:
independent, grade `consequence` — ended by the operating system or a
supervisor) — two channels, because a process's own
exit code and an outside termination differ in independence (OVP-CHAN-5) —
`app.window.opened` ○,
`app.window.closed` ○ — replay `session`. Reference kinds: `app.process`
(durable for the identity), `app.window` (volatile). `app.signal` ○ (channel
`signal`) carries events the application announces about itself.
Inter-process traffic (Electron IPC, Tauri commands) is an extension, observed
on channel `x-ipc` (actuation-derived, grade `consequence`). Provisioning:
`{ path | command (hostOnly), args?, env? (hostOnly), fixture? }`.

### `device@1` (extends `ui@^1`)

A simulator, emulator or physical device running apps. Servers that can
capture the screen also declare `screen@1`.

| Operation | Input → Output | |
|---|---|---|
| `device.info` | `{}` → `{ platform, osVersion, model, orientation, buttons }` | ● ★ |
| `device.app.install` | `{ path }` → `{ app: ref }` (effects, idempotency required, task: may) | ● |
| `device.app.launch` | `{ app \| bundleId, args? }` → `{ app: ref }` (effects) | ● ★ |
| `device.app.terminate` | `{ app }` → `{}` (effects) | ● |
| `device.openUrl` | `{ url }` → `{}` (effects) | ● |
| `device.button` | `{ name }` → `{}` (effects) | ● |
| `device.rotate` | `{ orientation }` → `{ orientation }` (effects) | ○ |
| `device.appearance.set` | `{ appearance: 'light' \| 'dark' }` → `{}` (effects) | ○ |
| `device.logs.read` | `{ app?, since? }` → `{ lines }` (channel `log`) | ○ |
| `device.test.run` | `{ plan }` → `{ passed, failed, report: blob }` (effects, idempotency required, task: always) | ○ |

`device.info.buttons` lists the hardware buttons the instance has;
`device.button` with any other name fails with `unsupported`. Resources:
`device.summary` (foreground app, orientation; `every-turn`) ●. Events:
`device.app.crashed` ● (channel `log`, argument `app?`, replay `durable`),
`device.log` ○. Reference kinds: `device.app`. Provisioning: `{ model?,
osVersion?, fixture? }`. Platform-specific capabilities — permission dialogs,
intents, HealthKit — are extensions.

### `chat@1`

A messaging workspace: Slack, Microsoft Teams, Discord, Google Chat.

| Operation | Input → Output | |
|---|---|---|
| `chat.post` | `{ channel, text, attachments? }` → `{ message: ref, thread: ref }` (effects, idempotency required) | ● ★ |
| `chat.reply` | `{ thread, text, attachments? }` → `{ message: ref }` (effects, idempotency required) | ● ★ |
| `chat.history.read` | `{ channel?, thread?, cursor?, limit? }` → `{ messages, cursor? }` (channel `state`) | ● ★ |
| `chat.channels.list` | `{ cursor? }` → `{ channels: [{ channel: ref, name, kind }], cursor? }` | ● |
| `chat.react` | `{ message, emoji }` → `{}` (effects) | ○ |
| `chat.edit` | `{ message, text }` → `{}` (effects, idempotency required) | ○ |
| `chat.delete` | `{ message }` → `{}` (effects, guarded) | ○ |
| `chat.users.lookup` | `{ user \| email }` → `{ user: ref, name, email? }` | ○ |
| `chat.typing` | `{ thread }` → `{}` (effects) | ○ |

Text is CommonMark; servers translate to and from the platform's markup.
`chat.channel` and `chat.user` references are `public`. Messages are the
workspace's state, read through the same platform API whether by history or by
event, so both are channel `state`; identity surface `x-chat`. Events (channel
`state`):
`chat.message.created` ● (arguments `channel?`, `thread?`, `mentionsAgent?`;
replay `durable`), `chat.message.updated` ○, `chat.message.deleted` ○,
`chat.reaction.added` ○. Resources: `chat.thread.recent` (`on-change`) ●.
Determinism default: `{ reset: 'none', replayPrefix: 'unsafe', time: 'wall',
observation: 'sampled', actions: 'irreversible' }`.

## Future Considerations

- More profiles: `email`, `calendar`, `issues` (GitHub, Linear, Jira),
  `service` (requests and responses against a backend, OVP's `effect` level
  with no UI), and `game`.
- Reference servers for each v1 profile (Playwright for `browser`, `simctl` and
  `adb` for `device`, a chat-sdk.dev-backed server for `chat`).
- A public registry of extension ids alongside reverse-domain ownership.
