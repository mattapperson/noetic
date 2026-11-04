# @noetic-tools/mcp

The MCP bridge for [Noetic](https://noetic.tools): `mcp()` turns any
[Model Context Protocol](https://modelcontextprotocol.io) server into a
connection (`specs/35-connections.md`).

```ts
import { mcp } from '@noetic-tools/mcp';

const linear = mcp({
  name: 'linear',
  type: 'http',
  url: LINEAR_MCP,
  headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
});

callModel({ id: 'triage', model, tools: [linear] });                // one step
new AgentHarness({ name: 'agent', params: {}, agentGraph, connections: [linear] }); // the harness
callModel({ id: 'read', model, tools: [connectionTools('linear', { ops: ['get_*'] }), search] });
```

`mcp()` takes ACP's `McpServer` shape, so an ACP server config is an
argument as it stands:

- `{ name, type: 'http' | 'sse', url, headers?: [{ name, value }] }` — a
  remote server (`'sse'` is the deprecated 2024-11-05 transport);
- `{ name, command, args?, env?: [{ name, value }] }` — a stdio server
  (`type: 'stdio'` is accepted too);
- `{ transport }` — a caller-built MCP transport, e.g. an in-process server.

The bridge options sit beside those fields: `auth`, `fetch` (remote),
`cwd` and `spawn` (stdio), `webhooks`, `profiles` / `extensions`
(definitions to check a declaring server against), `timeoutMs`,
`requestTimeoutMs`, `pollIntervalMs` and `clientInfo`. A header or
environment variable given twice is `CONNECTION_INVALID`.

```ts
mcp({ name: 'browser', command: 'npx', args: ['@playwright/mcp@latest'] });
mcp({ name: 'drive', type: 'http', url: DRIVE_MCP, auth: { kind: 'oauth', provider: driveOAuth } });
mcp({ name: 'deploys', type: 'http', url: DEPLOY_MCP, webhooks: { receiver: createWebhookReceiver({ port: 8787, publicUrl }) } });
```

`auth` signs in to a remote server: `{ kind: 'bearer', token }` sends
`Authorization: Bearer <token>`; `{ kind: 'oauth', provider }` hands an MCP
SDK `OAuthClientProvider` (re-exported here) to the transport, which handles
the 401, discovery and refresh. `auth` and an `Authorization` header together
are `CONNECTION_INVALID`. Credentials and headers never leave the server's
origin, and the bridge registers every token — an `Authorization` header's
included — with the harness (`ConnectOptions.redact`) so it is scrubbed like
a secret.

A JSON document names the same server as `{ "mcp": { "name": "linear",
"type": "http", "url": "…", "headers": [{ "name": "Authorization", "value":
{ "$secret": "linear.token" } }] } }`, granted by the host's `mcp` allowlist,
whose `provider` is `mcp` itself.

What the bridge does:

- **Operations** are tools; a declared alias maps an operation onto an
  existing tool with fixed arguments merged in. A tool's MCP `annotations`
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`,
  `title`) appear on the operation as `annotations`. Binary content is stored in
  the artifact store and passed as `{ $blob: … }`.
- **Profiles.** A server declares what it implements under
  `tools.noetic/profiles` in its `extensions` capability (spec 36). The
  bridge checks the declaration against what the server serves — and against
  the profile definitions it was given — and marks a server that contradicts
  it unavailable. A server with no declaration is a connection with no
  profile whose identity is the MCP session.
- **Reads** are resources named after the read (`ui.summary`);
  `noetic://identity` is the OVP subject; `noetic://coverage` and
  `noetic.detect` feed verification; `noetic.reset`, `noetic.provision` and
  `noetic.release` back `reset()` and pools.
- **Long operations** use the Tasks extension (SEP-2663): `tasks/get`,
  `tasks/update` (answers to `input_required`), `tasks/cancel`.
- **Events** use the Events extension (SEP-3415), by push, webhook (Standard
  Webhooks signatures, five-minute window, duplicate ids dropped) or poll,
  in that order of preference; events are deduplicated by id.
- **Errors** are `structuredContent: { code, message, details? }` with the
  codes of spec 36 § Errors; `tools.noetic/confirmed` is sent only when the
  harness approved a `guarded` call.

## Conformance

```ts
import { checkConformance } from '@noetic-tools/mcp/conformance';

const report = await checkConformance({
  server: { command: 'node', args: ['./my-browser-server.js'] },
  profile: browser,
  driver,
});
```

The driver causes what the server cannot (an ambiguous locator, a replaced
subject, an independent confirmation of an effect). A scenario the driver
cannot set up scores `absent`, which is not a pass.
