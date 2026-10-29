# @noetic-tools/mcp

The MCP bridge for [Noetic](https://noetic.tools): `mcp()` turns any
[Model Context Protocol](https://modelcontextprotocol.io) server into a
connection (`specs/35-connections.md`).

```ts
import { mcp } from '@noetic-tools/mcp';

const harness = new AgentHarness({
  connections: {
    browser: mcp('npx @playwright/mcp@latest'),
    slack: mcp({ url: 'https://slack-mcp.example.com/mcp', headers: { 'X-Tenant': 'acme' } }),
    deploys: mcp({ url: DEPLOY_MCP, webhooks: { receiver: createWebhookReceiver({ port: 8787, publicUrl }) } }),
  },
  // …
});
```

`mcp()` accepts a command line, `{ command, args?, env?, cwd? }`,
`{ url, headers?, protocol? }` or `{ transport }` (a caller-built MCP
transport, e.g. an in-process server), plus options: `webhooks`, `profiles` /
`extensions` (definitions to check a declaring server against), `timeoutMs`,
`requestTimeoutMs`, `pollIntervalMs`.

What the bridge does:

- **Operations** are tools; a declared alias maps an operation onto an
  existing tool with fixed arguments merged in. Binary content is stored in
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

const report = await checkConformance({ server: 'node ./my-browser-server.js', profile: browser, driver });
```

The driver causes what the server cannot (an ambiguous locator, a replaced
subject, an independent confirmation of an effect). A scenario the driver
cannot set up scores `absent`, which is not a pass.
