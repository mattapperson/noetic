# Chat Platform Integration: `@noetic-tools/chat-sdk`

> **Depends On:** `06-channels` (external channels — approval flow), `08-runtime` (session API — `execute`, streams, seeding)
> **Exports:** `noeticAgent()`, `toItems()`, `streamToChatChunks()`, `chatTools()`, `fromAiSdkTool()`, approval channels (`approvalRequests`, `approvalDecision()`, `resolveApproval()`), `createChatHistoryStore()`, `ChatHarness`, chat structural mirrors

---

`@noetic-tools/chat-sdk` is the official binding between a Noetic agent harness and [Chat SDK](https://chat-sdk.dev) (npm package `chat`), the multi-platform chat bot library for Slack, Teams, Google Chat, Discord, Telegram, Linear, and others. One handler wires the whole loop:

```typescript
import { Chat } from "chat";
import { noeticAgent } from "@noetic-tools/chat-sdk";

const chat = new Chat({ adapters: [...], state: redis() });
chat.onSubscribedMessage(noeticAgent({ harness }));
```

## Architecture

The package mirrors the sub-harness adapter shape (`27-sub-harness-steps`):

- Depends only on `@noetic-tools/types`. It drives any harness through `ChatHarness`, a structural subset of `AgentHarnessContract` (`execute`, `getFullStream`, `getItemStream`, `seedSessionHistory`, `getChannelHandle`, `getChannelStream`, `getStatus`, `getQueueSize`, `abort`).
- `chat` is an **optional peer dependency**. The core loop needs it only at the type level — the package ships structural mirrors (`ChatThreadLike`, `ChatMessageLike`, `ChatStreamChunk`) of the handful of shapes it touches, pinned to the real package by a compile-time compatibility test. `chatTools()` imports `chat/ai` lazily and fails with an install hint when the peer (or its `ai` peer) is absent.
- Core never imports this package (enforced by `.sentrux/rules.toml`).

## The message loop

`noeticAgent(options)` returns an `onSubscribedMessage` handler. Per incoming message:

1. **Seed on first contact.** The thread's platform history (`fetchMessages`, `historyLimit` messages, default 20) is converted via `toItems()` and installed with `seedSessionHistory`. With a history store configured, a previously-seeded thread loads from the store instead — conversations survive process restarts. A thread is marked seeded only on success: a failed platform fetch is non-fatal (the turn still runs unseeded) and the next message retries.
2. **Attach, then execute.** The handler binds a `getFullStream` iterator BEFORE calling `execute()`: `turn_started` is emitted synchronously inside `execute()`, and the session broadcaster discards events whenever a previously-consumed stream has no live consumer — a subscriber attached afterwards would miss the whole turn and `post()` would never resolve.
3. **Execute.** The triggering message becomes Items and is enqueued with `execute(input, { threadId, messageId, deliveryMode })`. The generated `messageId` is the correlation key for the turn.
4. **Stream back.** `thread.post(streamToChatChunks(events, { messageId }))` — the translated iterable terminates at the turn boundary, which is what resolves `post()`.

Concurrent messages on one thread are safe. Messages that queue during an in-flight turn coalesce into one shared turn whose `turn_started.messageIds` lists them all; only the FIRST id's handler claims and posts the turn, so the reply lands exactly once. A `between-rounds` delivery injects into the running turn and is claimed via its `inbox_injected` event instead, ending at that turn's boundary. `deliveryMode` (`next-turn` default, `between-rounds`, `interrupt`) governs how a message lands mid-generation.

## Item conversion (`toItems`)

Chat SDK messages map onto Open Responses items, oldest first (sorted by `dateSent`):

| Platform message | Item |
|---|---|
| `author.isMe` (the bot's own) | assistant `MessageItem` with one `output_text` part |
| anyone else | user `InputMessageItem`; text rendered `userName: text` so group threads keep attribution |
| image attachment with URL | `input_image` part |
| other attachment with URL | `input_file` part |

Platform message ids become item ids. `isAssistant` and `formatMessage` hooks override detection and rendering; `formatMessage` returning `null` drops a message. Messages that render to no text and no usable attachment are dropped.

## Stream translation (`streamToChatChunks`)

A state machine over `StreamEvent`s:

1. **Correlate.** Events are skipped until a framework event whose type ends in `:turn_started` (framework types are prefixed with the harness `config.name`) carries the caller's `messageId` in `data.messageIds`; its `turnId` scopes the rest. This also discards the session broadcaster's replay buffer.
2. **Text.** `response.output_text.delta` passes through as string chunks. When a second assistant message opens in the same turn (`response.output_item.added` after text was emitted), a separator (default blank line) is injected first — platforms concatenate raw deltas otherwise.
3. **Tool cards.** `tool_call_started` / `tool_call_completed` become `task_update` chunks keyed by `callId` with status `in_progress` → `complete`/`error`; Slack and Linear render these natively, other platforms degrade via Chat SDK's own fallbacks. `taskTitle` customizes card titles. Calls still open at the turn boundary are flushed (`complete` on completion, `error` on abort) so no card is left spinning.
4. **Terminate.** `turn_completed` (matching `turnId`, or any boundary for an injected claim) ends the iterable. `turn_aborted` flushes open cards, then yields the `abortNotice` — a generic `_(turn aborted)_` by default, never the raw internal reason string.

Constraint: a harness `config.name` must not itself end in a `:`-prefixed event name (e.g. `:turn_started`), since matching is suffix-based.

## Tools and approvals

`chatTools({ chat, preset?, scope?, requireApproval?, approvalTimeoutMs? })` wraps Chat SDK's `createChatTools()` (post, DM, react, edit, delete, subscriptions) into Noetic `Tool`s via the general-purpose `fromAiSdkTool(name, aiTool, options?)`, which preserves the AI SDK tool's zod `inputSchema` and delegates `execute`. **Approval defaults follow the vendor:** Chat SDK ships its write tools gated (`needsApproval: true`), and the wrapper inherits that — `requireApproval` only overrides per tool or wholesale. A dynamic vendor predicate counts as gated.

Approval gating runs on external channels (`06-channels`), not the AI SDK loop:

1. A gated tool sends `{ requestId, toolName, args, threadId }` on the shared `approvalRequests` queue channel, then waits on the shared `approvalDecisions` topic channel (receiver parked *before* the request is sent, so a decision cannot race past it), filtering broadcasts by its `requestId` under a deadline (default 5 minutes).
2. The integration subscribes ONCE per harness with the never-closed lifetime scope: `harness.getChannelStream(approvalRequests, APPROVAL_SCOPE)`. Queue delivery is competing-consumer and channel-scoped, so a single subscriber is the correctness requirement — the request's `threadId` tells it which conversation gets the card.
3. The button click calls `resolveApproval({ harness, decision: { requestId, approved, reason? } })`, which broadcasts on `approvalDecisions`. It returns `false` (never throws) when the channel is no longer open — stale button clicks are expected, and a platform action handler is no place for `channel_closed`. A rejection or timeout surfaces to the model as a tool error.

Session-mode harnesses work out of the box: `APPROVAL_SCOPE` is a harness-lifetime scope id, so the approval stream spans turns and no per-turn execution id is ever needed. Vendor tools receive a synthetic `toolCallId` and are not cancelled mid-flight on turn abort (the harness exposes no abort signal to tool executors).

## Persistence

`createChatHistoryStore(state)` implements the platform-node `ChatHistoryStore` contract over a two-method KV seam (`get`/`set`) that any Chat SDK state adapter satisfies, plus `isSeeded`/`markSeeded` so first-contact detection is durable across restarts and workers (Chat SDK's distributed locking serializes per-thread handlers). With `history` configured, `noeticAgent` seeds from the store when marked, persists input items before execute, and pumps completed model items from `getItemStream` into the store. A per-thread persisted-id set deduplicates: the item stream emits cumulative snapshots (the same completed item more than once), and a restarted pump replays the whole broadcaster buffer — neither may duplicate stored history. Corrupt stored state reads as empty history (with a warning) instead of throwing.

Without a store, first-contact tracking is per-process.

## Future Considerations

- Rendering OpenUI fragments (`28-generative-ui`) to Chat SDK cards/Block Kit.
- Interview-pattern (`13-patterns`) integration with platform modals.
- `plan_update` chunks from the plan memory layer.
- Cancelling in-flight vendor tool calls on turn abort, once the harness exposes an abort signal to tool executors.
