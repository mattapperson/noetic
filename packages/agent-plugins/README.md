# @noetic-tools/agent-plugins

An [Agent Plugins](https://agent-plugins.org) v1 client for Noetic.

Agent Plugins is an open, vendor-neutral standard for packaging reusable agent
components. A plugin is a directory with a `plugin.json` manifest and two
portable component types:

- **Skills** — `skills/<name>/SKILL.md`, per the
  [Agent Skills specification](https://agentskills.io/specification)
- **MCP servers** — `mcp.json`, over stdio, Streamable HTTP, or the legacy
  HTTP+SSE transport

This package discovers those packages, shows their skills to a model through
the `agentPlugins()` context layer, and turns their MCP servers into harness
connections with `pluginConnections()`.

```bash
bun add @noetic-tools/agent-plugins
```

```ts
import { agentPlugins, discoverPlugins, pluginConnections } from '@noetic-tools/agent-plugins';
import { AgentHarness } from '@noetic-tools/core';

const roots = ['/home/alex/.agents/plugins'];
const dataDir = '/home/alex/.agents/plugins-data';
const { connections } = await pluginConnections(await discoverPlugins(roots, dataDir));

const harness = new AgentHarness({
  name: 'agent',
  params: {},
  contextLayers: [agentPlugins({ roots, dataDir })],
  connections, // or harness.execute(input, { connections }) for one turn
});
```

## Progressive disclosure

The layer implements the three tiers the Agent Skills specification
prescribes, so a large plugin set costs a small, fixed amount of context:

1. **Metadata** — every skill's name and description appear on every turn.
   This is what lets the model know a skill exists.
2. **Instructions** — `loadSkill` returns a `SKILL.md` body and pins it for the
   rest of the thread.
3. **Resources** — `readSkillResource` reads one bundled file at a time from
   `scripts/`, `references/`, or `assets/`.

Only activation changes the rendered block, so the layer is `'anchor'`-placed
and implements `renderDelta`: a newly activated skill is published as a delta
rather than rewriting the cached prompt prefix.

## MCP

Declared servers are validated and resolved here. `pluginConnections()`
returns one [`@noetic-tools/mcp`](../mcp) connection entry per server, named
`<plugin>_<server>` and exposed with `expose: 'call'`, so the model reaches a
server through `<name>_ops` / `<name>_call` (or the shared `ops` / `call` with
`target` when several connections use `'call'`). A plugin's tools pass the same
gates as every other connection: policy, `beforeToolCall`, approval, secret
scrubbing and replay-stable idempotency keys. Two servers that map to one name
fail with `CONNECTION_NAME_TAKEN`. Leave `pluginConnections()` out for a
skills-only client, which the specification explicitly permits.

## Failures are isolated

The specification's central property is that a broken part of a plugin never
takes down a working part. A non-conforming `SKILL.md` never stops its
siblings; a server that will not start is an unavailable connection and never
stops the plugin's skills or any other connection. Every
skip produces a diagnostic naming the specification section it enforces,
readable via `layer.readDiagnostics()` and emitted onto the execution trace.

## Security

Plugins are third-party code on disk, so the specification's containment rules
are enforced rather than assumed:

- Package paths are resolved through `realpath`; a symlink cannot smuggle a
  path out of the plugin root, and an unresolvable path is treated as an escape.
- MCP `command` must be a single executable token, never a shell command
  string.
- Plugin subprocesses get a narrow environment allowlist, not the agent's
  environment — ambient secrets are not passed through — and `PLUGIN_ROOT` /
  `PLUGIN_DATA` are applied last so they cannot be spoofed.

Configured `env` values and MCP headers are visible package data. The
specification is explicit that neither is a secret mechanism; do not put
credentials in either.

## Documentation

- Layer reference: https://noetic.tools/docs/framework/context-layers/agent-plugins
- Design notes: `specs/30-agent-plugins.md`
- Conformance evidence: `test/conformance.test.ts`, one test per checkbox of
  the specification's Appendix A checklist.

## License

Apache-2.0
