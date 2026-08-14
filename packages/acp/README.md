# @noetic-tools/acp

An [Agent Client Protocol](https://agentclientprotocol.com/) client for [Noetic](https://noetic.tools). Run any ACP-speaking coding agent — Claude Code, Codex, Gemini CLI — as a step in a Noetic agent.

```bash
bun add @noetic-tools/acp
```

## Usage

```ts
import { AgentHarness, step } from '@noetic-tools/core';
import { claudeCode } from '@noetic-tools/acp';

const review = step.acpAgent({
  id: 'review',
  agent: claudeCode(),
  prompt: 'Review the working tree and summarize the risks',
  permissions: { default: 'deny', allow: [{ kind: 'read' }] },
});

const harness = new AgentHarness({ name: 'reviewer', params: {} });
const summary = await harness.run(review, 'go', harness.createContext());
console.log(summary);
```

## What this package does

ACP is bidirectional: the agent does not reach for the machine itself, it asks the client to read files, write files, and run terminals, and it asks permission before running a tool. This package implements that client side against Noetic's own adapters, so a sub-agent's file and shell access goes through them rather than around them — and **`fs/*` paths are confined to the session working directory by default**, since ACP puts boundary enforcement on the client.

- `fs/read_text_file`, `fs/write_text_file` → the execution context's `FsAdapter`
- `terminal/create`, `output`, `wait_for_exit`, `kill`, `release` → its `ShellAdapter`
- `session/request_permission` → a declarative policy, then steering, then an async handler; the default is **deny**
- `session/update` → the harness event surface, so ACP output streams like a `callModel` step's

Every `fs/*` and `terminal/*` call is also emitted as an `acp_client_activity` event, allowed or refused — an observed record of what the agent reached for, not its own account of itself.

Because every ACP agent is a uniform JSON-RPC peer, there is no vendor SDK per agent and no closed list of supported agents.

## Agents

```ts
import { claudeCode, codex, gemini, customAcpAgent } from '@noetic-tools/acp';
```

Each preset is only a launch recipe (which binary, which flags) and accepts `command` / `args` / `env` overrides plus a `transport` for agents that are not local child processes. `customAcpAgent({ agentId, command, args })` covers anything else that speaks the protocol.

## Entry points

| Import | Contents |
|---|---|
| `@noetic-tools/acp` | Protocol client, permission resolver, terminal registry, agent presets, loopback transport. No static `node:*` import; `child_process` loads only when a stdio connection opens. |
| `@noetic-tools/acp/stdio` | The Node stdio transport (`node:child_process`). Presets reach it through a lazy `import()`. |

## Testing

`loopbackTransport` stands an in-process agent on the far end of a **real** protocol connection — full handshake, sessions, notifications, and client callbacks — with no process to spawn:

```ts
import { defineAcpAgent, loopbackTransport } from '@noetic-tools/acp';

const fake = defineAcpAgent({
  agentId: 'fake',
  transport: loopbackTransport((conn) => ({
    async initialize(params) {
      return { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] };
    },
    async newSession() { return { sessionId: 's1' }; },
    async authenticate() { return {}; },
    async prompt(params) {
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      });
      return { stopReason: 'end_turn' };
    },
    async cancel() {},
  })),
});
```

## Documentation

- [ACP Agent Steps](https://noetic.tools/docs/framework/acp-agents)
- [Agent Client Protocol](https://agentclientprotocol.com/)

## License

Apache-2.0
