# @noetic-tools/mcp

Serves Noetic tools over the [Model Context Protocol](https://modelcontextprotocol.io), so an external coding agent run by `step.acpAgent` can call the same `tool()` definitions a `callModel` step uses.

You rarely use this package directly: `@noetic-tools/acp` starts it for you when a step passes `tools`.

```ts
import { step, tool } from '@noetic-tools/core';
import { claudeCode } from '@noetic-tools/acp';

step.acpAgent({ id: 'fix', agent: claudeCode(), prompt: 'Fix the bug', tools: [lookup] });
```

## Entries

- `@noetic-tools/mcp` — `createToolServer(getHost)`: an MCP server whose `tools/list` and `tools/call` read an `AcpToolHost`. Runtime-neutral.
- `@noetic-tools/mcp/node` — `serveToolsOverHttp(getHost)`: that server over streamable HTTP on `127.0.0.1`, at a random port and path, behind a bearer token, refusing requests with a web `Origin` or a foreign `Host`.

See `specs/36-acp-tools.md` and the [ACP agents guide](https://noetic.tools/docs/framework/acp-agents).
