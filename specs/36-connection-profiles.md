# 36 — Connection Profiles

> **Depends On:** `35-connections` (Connection, ConnectionEvent, ConnectionReference)
> **Exports:** `defineProfile`, `defineExtension`, `Profile`, `Extension`, `ProfileOperation`, `ProfileEvent`, `ProfileResource`, `reference()`; the `screen`, `browser`, `device` and `chat` profiles (`@noetic-tools/profile-*`); `checkConformance` (`@noetic-tools/profile-conformance`)

---

MCP standardizes how a client calls a tool, reads a resource, runs a task and
receives an event. It does not standardize *which* tools a browser server
offers or what a chat event looks like, so an agent written against one Slack
server breaks on the next. A **profile** fixes that vocabulary for one kind of
surface: operation names and schemas, resources, event types with their
arguments and payloads, and which operations run as tasks. Any MCP server that
implements a profile works with any agent written against it.

A profile is a **floor, not a ceiling.** A conforming server implements all of
the profile's required parts and may offer anything else as **extensions** —
versioned, namespaced additions that agents can require explicitly. Profiles
stay small and portable; extensions keep each platform fully usable.

## Defining a profile

```ts
import { defineProfile, reference } from '@noetic-tools/types';
import { z } from 'zod';

export const chat = defineProfile({
  name: 'chat',
  version: '1.0.0',
  operations: {
    'chat.reply': {
      description: 'Reply in a thread.',
      input: z.object({ thread: reference('chat.thread'), text: z.string(), attachments: z.array(AttachmentSchema).optional() }),
      output: z.object({ message: reference('chat.message') }),
      required: true,
      effects: true,
    },
  },
  resources: {
    'chat.thread.recent': { uri: 'chat://threads/{thread}/recent', schema: RecentMessagesSchema, observe: true },
  },
  events: {
    'chat.message.created': {
      arguments: z.object({ channel: reference('chat.channel').optional(), thread: reference('chat.thread').optional(), mentionsAgent: z.boolean().optional() }),
      payload: MessageCreatedSchema,
      replay: true,
      required: true,
    },
  },
});
```

A profile is data: `defineProfile` validates the definition and returns a
frozen `Profile` whose types flow into `step.connectionCall` and whose schemas
drive JSON validation, the generated JSON Schema, negotiation and conformance.
One definition serves all of them.

| Part | Fields |
|---|---|
| `name` | One lowercase label, `[a-z][a-z0-9-]*`. |
| `version` | Semver. The major is part of the profile's identity (`chat@1`). |
| `extends` | Parent profiles with ranges, e.g. `{ screen: '^1.1' }`. Their parts are inherited unchanged. |
| `operations` | Name → `{ description, input, output, required, effects, task }`. Names are `<profile>.<verb>` or `<profile>.<noun>.<verb>`. |
| `resources` | Name → `{ uri, schema, observe }`. `observe: true` puts it in the default observation layer (spec 35). |
| `events` | Event type → `{ arguments, payload, replay, required }`. |

- **`effects`** marks an operation that changes something upstream. A
  conforming server must honor idempotency keys for it (§ Idempotency).
- **`task`** is `'never'`, `'may'` (default) or `'always'`. Task creation is
  the server's decision (SEP-2663); this field is a conformance assertion about
  that decision: `'always'` operations must return a task, `'never'`
  operations must not.
- **`arguments`** is the event type's subscription arguments schema
  (SEP-3415 `inputSchema`), so profiles standardize server-side filters, not
  just payloads.
- **`replay`** states whether the event type must support cursors. `true`
  makes a `null` cursor a conformance failure.
- All names — operations, resources, event types — use only letters, digits,
  `_`, `-` and `.`, the characters MCP allows in tool names, and are used on
  the wire verbatim.

### Inheritance

`extends` names each parent with a range. A server declaring
`device@1.2.0` must also declare a `screen` version inside the range
`device@1.2.0` gives for it, and a slot requiring `device@^1.2` implicitly
requires that parent range. Inherited operations are therefore versioned
through their child.

### References

`reference(kind)` marks a field as an id that only means something on the
instance that issued it (`chat.thread`, `chat.message`, `device.app`). On the
wire it is a plain string; the harness wraps it as a `ConnectionReference`,
records where it came from, and routes by it (spec 35 § References). Kinds are
namespaced by the profile that defines them. `reference(kind, { public: true })`
marks a kind a person can know without the harness issuing it — a channel id, a
device serial — which skips the harness's provenance check but is still routed
and gated. Task references (`task`) are built in.

### Operation errors

An operation that fails returns an MCP tool error whose `structuredContent`
carries `{ code, message, details? }`. Profiles share these codes:

| Code | Meaning |
|---|---|
| `unsupported` | The instance cannot do this, e.g. a button the device lacks. |
| `not_found` | A referenced object no longer exists. |
| `invalid_reference` | A reference is malformed or of the wrong kind. |
| `permission_denied` | The upstream refused the caller. |
| `rate_limited` | The upstream throttled the call; `details.retryAfterMs` when known. |
| `busy` | The instance is occupied, e.g. a device mid-install. |
| `conflict` | An idempotency key was reused with different arguments. |

A profile may add codes for its own operations, prefixed with its name.

### Idempotency

Every call carries `_meta["tools.noetic/idempotency-key"]` (spec 35 §
Durability). For an operation with `effects: true`, a conforming server that
receives a key it has already seen with the same arguments returns the
original outcome — the same result, or the same task — without repeating the
effect, for at least 24 hours. The same key with different arguments fails with
`conflict`.

## Extensions

```ts
import { defineExtension } from '@noetic-tools/types';

export const slackBlocks = defineExtension({
  id: 'com.slack.blocks',
  version: '3.0.0',
  requires: { chat: '^1' },
  operations: {
    'com.slack.blocks.post': { input: BlocksPostSchema, output: z.object({ message: reference('chat.message') }), effects: true },
  },
  events: {
    'com.slack.blocks.action': { arguments: BlockActionFilterSchema, payload: BlockActionSchema, replay: true },
  },
  inputExt: {
    'chat.post': z.object({ unfurlLinks: z.boolean().optional() }),
  },
  payloadExt: {
    'chat.message.created': z.object({ blocks: z.array(BlockSchema).optional() }),
  },
});
```

- **Ids** are a reverse domain the vendor controls followed by a name
  (`com.slack.blocks`, `com.acme.ios-permissions`), at least three labels, so
  no extension id can equal a profile name. Every operation, event type and
  resource an extension adds starts with its id, so nothing an extension adds
  can collide with a profile or with another vendor's extension.
- **`requires`** names the profile ranges the extension builds on. An extension
  with no `requires` stands alone; triggers (spec 35) are extensions of this
  kind.
- Extensions are versioned independently of the profiles they build on, by the
  same rules (§ Versioning).

### Adding fields

An extension may add fields to profile operations and events, always under its
own id so two extensions — or a later profile minor — can never define the
same field:

| Declared as | Lands at |
|---|---|
| `inputExt` (optional fields only) | `args.ext["<extension id>"]` |
| `outputExt` | `result.ext["<extension id>"]` |
| `payloadExt` | `payload.ext["<extension id>"]` |

A caller or consumer using only the profile's fields is unaffected. An
extension can never change a profile schema, make an optional profile part
required, or remove anything.

## Versioning

Profiles and extensions follow semver, judged from the consumer's side:

| Change | Version |
|---|---|
| Fix a description, tighten documentation | patch |
| Add an optional operation, event type, resource, input field, output field or event argument | minor |
| Make an optional part required, remove anything, rename anything, narrow an input, widen an output enum, turn off `replay` | major |

A new major is a new identity: `chat@2`'s operations are distinct from
`chat@1`'s even where the names match. An instance implements one major of a
profile. A server that serves several majors does so as separate instances,
each declaring its own (§ Wire declaration); the harness gives each major its
own model-facing tools (spec 35 § Tool names). An agent pinned to `chat@^1`
keeps working however far the profile moves.

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
        "profiles": { "device": "1.2.0", "screen": "1.1.0" },
        "extensions": { "com.acme.ios-permissions": "1.0.0" },
        "instances": [
          { "id": "iphone-16", "title": "iPhone 16 · iOS 26.0" },
          { "id": "ipad-air", "title": "iPad Air · iOS 26.0",
            "extensions": { "com.acme.ios-permissions": "1.0.0", "com.acme.ipad-multitasking": "1.0.0" } }
        ]
      }
    }
  }
}
```

- Every parent of a declared profile is declared too, inside the child's range.
- `instances` is present only when one server serves several instances. An
  instance entry's `profiles` and `extensions`, when present, replace the
  server-level ones for that instance, so a mixed fleet — iPhone and iPad,
  API 30 and API 35, Slack and Teams behind one bridge — declares each device
  or workspace exactly. Every `tools/call`, `resources/read`, `tasks/*` and
  `events/*` request to such a server carries `_meta["tools.noetic/instance"]`;
  a request without it is rejected with `InvalidParams`.
- Operation names are the server's MCP tool names, event types its SEP-3415
  event names, and resource names its resource template names, all verbatim.
- Anything the server offers outside its declared profiles and extensions is
  still usable as an ordinary MCP tool, but no workflow can require it.

## Conformance

Each profile package ships its conformance scenarios: ordered steps that call
required operations, read required resources and subscribe to required events,
asserting the results against the profile schemas. Some steps need something to
happen outside the server — a message posted by another user, an app crashing —
so a scenario can ask a **driver** the server author supplies to cause it.

```ts
import { checkConformance } from '@noetic-tools/profile-conformance';
import { chat } from '@noetic-tools/profile-chat';

const report = await checkConformance({
  server: { command: 'slack-mcp', args: ['--workspace', 'conformance'] },
  profile: chat,
  extensions: [slackBlocks],
  driver: slackConformanceDriver,
});
```

- Conformance checks what is **required** by the profile, plus the declared
  extensions' own scenarios. Extras never fail a server.
- It checks the wire declaration and parent ranges, every required operation's
  input and output schemas, operation error shapes, `task` assertions,
  idempotency on `effects` operations, required events with their arguments,
  cursors on `replay` event types, reference round trips, and per-instance
  `_meta` routing when instances are declared.
- The report names each failed requirement with the profile part it comes
  from. A server may claim conformance in its documentation only with a
  passing report for the declared versions.

## Graduation

When several servers ship extensions that do the same thing, it becomes part of
the profile: first as an optional part in a minor version, later — if it proves
universal — required in the next major. The extensions stay valid for agents
that require them; servers may keep offering both.

## Catalog v1

Each profile below is its own package, `@noetic-tools/profile-<name>`. Required
parts are marked ●, optional ○.

### `screen@1`

Pixel- and element-level control of anything with a screen. Shared by
`browser`, `device` and desktop servers, so one action vocabulary works on all
of them.

**Coordinates.** Every `x`/`y` an operation takes or returns is in the pixel
space of the most recent `screen.capture` of that instance (its `width` ×
`height`), whatever the platform's own units — points, physical pixels or CSS
pixels. A server converts. A model can therefore act on exactly what it saw.
Element references from `screen.find` are preferred over coordinates where the
platform can resolve them.

| Operation | Input → Output | |
|---|---|---|
| `screen.capture` | `{ region? }` → `{ image, width, height }` | ● |
| `screen.find` | `{ query }` → `{ elements: [{ element: ref, role, name, bounds }] }` | ● |
| `screen.tap` | `{ element? \| x, y, count? }` → `{}` (a click on pointer devices) | ● |
| `screen.type` | `{ text, element? }` → `{}` | ● |
| `screen.key` | `{ key, modifiers? }` → `{}` | ● |
| `screen.scroll` | `{ direction, amount?, element? \| x, y }` → `{}` | ● |
| `screen.drag` | `{ path: [{ x, y, dtMs? }] }` → `{}` | ○ |
| `screen.longPress` | `{ element? \| x, y, durationMs }` → `{}` | ○ |

All actions have `effects: true`. Resources: `screen.current` (latest capture,
observed) ●. Events: `screen.changed` ○ (no arguments, `replay: false`).
Reference kinds: `screen.element`.

### `browser@1` (extends `screen@^1`)

| Operation | Input → Output | |
|---|---|---|
| `browser.navigate` | `{ url, tab? }` → `{ url, title }` | ● |
| `browser.back` / `browser.forward` / `browser.reload` | `{ tab? }` → `{ url }` | ● |
| `browser.snapshot` | `{ tab? }` → accessibility tree with `screen.element` refs | ● |
| `browser.tabs.list` | `{}` → `{ tabs: [{ tab: ref, url, title, active }] }` | ● |
| `browser.tabs.open` / `close` / `select` | `{ url? \| tab }` → `{ tab: ref }` | ● |
| `browser.evaluate` | `{ expression, tab? }` → `{ value }` | ○ |
| `browser.text` | `{ tab? }` → `{ text }` (readable page text) | ○ |

Resources: `browser.page` (url, title, snapshot; observed) ●. Events:
`browser.page.loaded` ●, `browser.dialog.opened` ●, `browser.console` ○, each
with an optional `tab` argument and `replay: false`. Reference kinds:
`browser.tab`.

### `device@1` (extends `screen@^1`)

A simulator, emulator or physical device running apps.

| Operation | Input → Output | |
|---|---|---|
| `device.info` | `{}` → `{ platform, osVersion, model, orientation, buttons }` | ● |
| `device.app.install` | `{ path }` → `{ app: ref }` (task: may) | ● |
| `device.app.launch` | `{ app: ref \| bundleId, args? }` → `{ app: ref }` | ● |
| `device.app.terminate` | `{ app: ref }` → `{}` | ● |
| `device.openUrl` | `{ url }` → `{}` | ● |
| `device.button` | `{ name }` → `{}` | ● |
| `device.rotate` | `{ orientation }` → `{ orientation }` | ○ |
| `device.appearance.set` | `{ appearance: 'light' \| 'dark' }` → `{}` | ○ |
| `device.logs.read` | `{ app?: ref, since? }` → `{ lines }` | ○ |
| `device.test.run` | `{ plan }` → `{ passed, failed, report }` (task: always) | ○ |

`device.info.buttons` lists the hardware buttons the instance has (`home`,
`back`, `lock`, `volumeUp`, `volumeDown`, …); `device.button` with any other
name fails with `unsupported`. Resources: `device.state` (foreground app,
orientation; observed) ●. Events: `device.app.crashed` ● (argument `app?`,
`replay: true`), `device.log` ○. Reference kinds: `device.app`.

Platform-specific capabilities — permission dialogs, intents, HealthKit, ADB
shell — are extensions (`com.acme.ios-permissions`,
`com.acme.android-intents`).

### `chat@1`

A messaging workspace: Slack, Microsoft Teams, Discord, Google Chat.

| Operation | Input → Output | |
|---|---|---|
| `chat.post` | `{ channel: ref, text, attachments? }` → `{ message: ref, thread: ref }` | ● |
| `chat.reply` | `{ thread: ref, text, attachments? }` → `{ message: ref }` | ● |
| `chat.history.read` | `{ channel?: ref, thread?: ref, cursor?, limit? }` → `{ messages, cursor? }` | ● |
| `chat.channels.list` | `{ cursor? }` → `{ channels: [{ channel: ref, name, kind }], cursor? }` | ● |
| `chat.react` | `{ message: ref, emoji }` → `{}` | ○ |
| `chat.edit` | `{ message: ref, text }` → `{}` | ○ |
| `chat.delete` | `{ message: ref }` → `{}` | ○ |
| `chat.users.lookup` | `{ user: ref \| email }` → `{ user: ref, name, email? }` | ○ |
| `chat.typing` | `{ thread: ref }` → `{}` | ○ |

Text is CommonMark; servers translate to and from the platform's own markup.
`chat.channel` and `chat.user` references are `public`. Events:
`chat.message.created` ● (arguments `channel?`, `thread?`, `mentionsAgent?`;
payload `author`, `thread`, `channel`, `text`, `attachments`, `mentionsAgent`;
`replay: true`), `chat.message.updated` ○, `chat.message.deleted` ○,
`chat.reaction.added` ○. Resources: `chat.thread.recent` (observed) ●.
Reference kinds: `chat.channel`, `chat.thread`, `chat.message`, `chat.user`.

Platform features with no portable equivalent — Slack Block Kit, Teams
Adaptive Cards, Discord components — are extensions.

## Future Considerations

- More profiles: `email`, `calendar`, `issues` (GitHub, Linear, Jira),
  `desktop` (window and application management on top of `screen`).
- Reference servers for each v1 profile (Playwright for `browser`, `simctl` and
  `adb` for `device`, a chat-sdk.dev-backed server for `chat`).
- A public registry of extension ids alongside reverse-domain ownership.
