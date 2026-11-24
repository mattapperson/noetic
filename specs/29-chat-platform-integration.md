# Chat Platform Integration: `@noetic-tools/chat-sdk`

> **Depends On:** `06-channels` (external channels — approval flow), `08-runtime` (session API — `execute`, streams, seeding)
> **Exports:** `noeticAgent()`, `toItems()`, `streamToChatChunks()`, `chatTools()`, `fromAiSdkTool()`, approvals (`chatApprover()`, `answerApproval()`, `approvalRequests`, `approvalDecisions`, `resolveApproval()`, `APPROVAL_SCOPE`), `createChatHistoryStore()`, `ChatHarness`, chat structural mirrors

---

`@noetic-tools/chat-sdk` is the official binding between a Noetic agent harness and [Chat SDK](https://chat-sdk.dev) (npm package `chat`), the multi-platform chat bot library for Slack, Teams, Google Chat, Discord, Telegram, Linear, and others. One handler wires the whole loop:

```typescript
import { Chat } from "chat";
import { noeticAgent } from "@noetic-tools/chat-sdk";

const chat = new Chat({ adapters: [...], state: redis() });
chat.onSubscribedMessage(noeticAgent({ harness }));
```

## Architecture

The package mirrors the ACP client's package shape (`27-acp-agent-steps`):

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
5. **Parked turns.** `turn_parked` is not a boundary: the iterable stays open. A woken turn starts again under a new `turnId` with the same `messageIds`, so the next `turn_started` that carries the caller's `messageId` is followed to its end; other turns' events in between are skipped.
6. **Replayed turns.** A message delivered again after its turn finished starts no turn. Its `turn_replayed` event carries the recorded answer as `text`, which is yielded before the iterable ends.

Constraint: a harness `config.name` must not itself end in a `:`-prefixed event name (e.g. `:turn_started`), since matching is suffix-based.

## Tools and approvals

`chatTools({ chat, preset?, scope?, requireApproval?, approval?, approvalTimeout? })` wraps Chat SDK's `createChatTools()` (post, DM, react, edit, delete, subscriptions) into Noetic `Tool`s via the general-purpose `fromAiSdkTool(name, aiTool, options?)`, which preserves the AI SDK tool's zod `inputSchema` and delegates `execute`. **Approval defaults follow the vendor:** Chat SDK ships its write tools gated (`needsApproval: true`), and the wrapper inherits that — `requireApproval` only overrides per tool or wholesale. A dynamic vendor predicate counts as gated.

A gated tool is gated by the harness's approval seam (`08-runtime` § Held tool calls). Approval is the default; running a tool without it is what a host opts into, with `requireApproval: { <tool>: false }`.

1. The wrapper marks a gated tool `needsApproval` and does nothing else: the harness asks before the tool runs.
2. `chatApprover({ timeout? })` is the `approveToolCall` that asks in chat. It sends `{ requestId, toolName, args, threadId }` on the shared `approvalRequests` queue channel, with the tool call's own id as `requestId`, and answers `hold` with a deadline (default 5 minutes; `Infinity` for none). The call's record is in the harness's storage, so it survives a restart and its turn can park.
3. The integration subscribes ONCE per harness with the never-closed lifetime scope: `harness.getChannelStream(approvalRequests, APPROVAL_SCOPE)`. Queue delivery is competing-consumer and channel-scoped, so a single subscriber is the correctness requirement — the request's `threadId` tells it which conversation gets the card.
4. The button click calls `answerApproval({ harness, threadId, decision: { requestId, approved, reason? } })`, which answers the held call with a decision item passed to `harness.execute()`. It looks the call up with `harness.pending()` first, so a harness that cannot list held calls is never handed a decision it might read as a message. It resolves `true` only when a waiting call took the decision and `false` when nothing was waiting (a stale click, or a call someone else answered first). It throws when the harness fails for another reason, such as storage that cannot be reached: that click was not delivered. A rejection or a passed deadline surfaces to the model as a tool error.

A harness with no approver still gates these tools: the call is held and listed by `harness.pending()`, and no request is sent to chat.

**Gating inside the tool.** `approval: 'channel'` keeps the earlier flow: the tool sends its request and waits on the shared `approvalDecisions` topic channel inside its own `execute` (receiver parked *before* the request is sent, so a decision cannot race past it), filtering broadcasts by its `requestId` under `approvalTimeout` (default 5 minutes). `approvalTimeout` belongs to this flow only: a call the harness holds takes its deadline from `chatApprover({ timeout })`, and `chatTools`/`fromAiSdkTool` throw when given `approvalTimeout` without `approval: 'channel'`. Such a tool does not declare `needsApproval`, so the harness approver is not asked a second time. `resolveApproval({ harness, decision })` broadcasts the decision and returns `false` when the channel is no longer open. The wait is in memory and ends with the process.

Session-mode harnesses work out of the box: `APPROVAL_SCOPE` is a harness-lifetime scope id, so the approval stream spans turns and no per-turn execution id is ever needed. Vendor tools receive a synthetic `toolCallId` and are not cancelled mid-flight on turn abort (the harness exposes no abort signal to tool executors).

## Persistence

`createChatHistoryStore(state)` implements the platform-node `ChatHistoryStore` contract over a two-method KV seam (`get`/`set`) that any Chat SDK state adapter satisfies, plus `isSeeded`/`markSeeded` so first-contact detection is durable across restarts and workers (Chat SDK's distributed locking serializes per-thread handlers). With `history` configured, `noeticAgent` seeds from the store when marked, persists input items before execute, and pumps completed model items from `getItemStream` into the store. A per-thread persisted-id set deduplicates: the item stream emits cumulative snapshots (the same completed item more than once), and a restarted pump replays the whole broadcaster buffer — neither may duplicate stored history. Corrupt stored state reads as empty history (with a warning) instead of throwing.

Without a store, first-contact tracking is per-process.

## Future Considerations

- Rendering OpenUI fragments (`28-generative-ui`) to Chat SDK cards/Block Kit.
- Platform modals as a structured-input surface for a clarifying-question composition (`13-patterns`) — the agent asks for missing fields through a modal instead of free-text turns.
- `plan_update` chunks from the plan layer.
- Cancelling in-flight vendor tool calls on turn abort, once the harness exposes an abort signal to tool executors.
