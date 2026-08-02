# @noetic-tools/chat-sdk

Official [Chat SDK](https://chat-sdk.dev) integration for [Noetic](https://noetic.tools). Run a Noetic agent harness as the brain of a multi-platform chat bot — Slack, Teams, Google Chat, Discord, Telegram, and every other Chat SDK adapter — with one line of wiring.

```typescript
import { Chat } from "chat";
import { noeticAgent } from "@noetic-tools/chat-sdk";

const chat = new Chat({ adapters: [...], state: redis() });

chat.onSubscribedMessage(noeticAgent({ harness, historyLimit: 20 }));
```

`noeticAgent` handles the full loop:

- **History seeding** — on first contact with a thread, platform messages are converted to Noetic items and seeded into the harness session.
- **Streaming** — the harness event stream is translated into Chat SDK stream chunks: text deltas stream as markdown, tool calls render as native task cards on platforms that support them (Slack, Linear), and the stream terminates cleanly at turn end.
- **Concurrency** — each incoming message correlates to its own harness turn, so overlapping messages on one thread stay untangled.

`chat` is an optional peer dependency: the package only needs it at the type level for the core loop, and imports `chat/ai` dynamically for the tool helpers.

See the [Noetic docs](https://noetic.tools/docs/framework/chat-sdk) for the full guide.

## License

Apache-2.0
