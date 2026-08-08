# 30 — Agent Plugins

`@noetic-tools/agent-plugins` is a conformant client for the
[Agent Plugins](https://agent-plugins.org) specification, v1.0.0. It discovers
plugin packages on disk and exposes their components to a model through a
single context layer, `agentPlugins()`.

Agent Plugins is a vendor-neutral packaging format. A plugin is a directory
with a closed `plugin.json` manifest and exactly two portable component types:

| Component | Fixed location | Format owner |
|---|---|---|
| Skills | `skills/<name>/SKILL.md` | [Agent Skills](https://agentskills.io/specification) |
| MCP servers | `mcp.json` | Agent Plugins (§7.2), wire behavior by [MCP](https://modelcontextprotocol.io/specification) |

Section references throughout this document are to the Agent Plugins v1.0.0
specification text.

## Why a separate package

The client needs the MCP SDK to speak the protocol, and it spawns subprocesses
to run stdio servers. Neither belongs anywhere lower in the stack:

- `@noetic-tools/context` must stay `types`-only and free of platform coupling
  so a context layer can be imported into a browser bundle.
- `@noetic-tools/core` must never acquire a vendor SDK in its dependency
  graph — the same rule that keeps sub-harness adapters out of core.

So the package sits alongside `@noetic-tools/sub-harness` and
`@noetic-tools/openui`: a consumer package built on the `ContextLayer` contract
in `@noetic-tools/types`, composed in by a host rather than imported by core.
`.sentrux/rules.toml` enforces both directions.

Because the package is Node-targeted by definition, it reads the filesystem
through `node:fs/promises` rather than `FsAdapter`. That is not incidental:
§4.1 containment is decided on filesystem-resolved paths, and `FsAdapter`
exposes no `realpath`.

## Failure boundaries

The spec's central design property is that a broken part of a plugin never
takes down a working part. Every failure is handled at the *narrowest* scope
that contains it:

| Scope | Trigger | Effect |
|---|---|---|
| Plugin | Unresolvable root, missing/invalid `plugin.json`, bad `name`, unsupported `$schema` | Plugin rejected; **no** component discovered (§11.3 rule 2) |
| Component type | Fixed location present but the wrong filesystem kind, or outside the root | That type unavailable; other types still load (§6.2, §4.1 rule 2) |
| Component entry | Non-conforming `SKILL.md`; invalid, unsupported, or unconnectable server | That entry skipped; siblings still load (§7.1, §7.2.2) |

Two manifest problems are explicitly **non-fatal** and must be reported and
ignored rather than rejected (§5.2, §8.1):

- an unknown top-level `plugin.json` field;
- an `extensions` value that is not an object.

This is why manifest validation is hand-rolled around a Zod schema for the
known fields instead of delegating to `z.strictObject().parse()`, which would
reject both.

Every skip produces a `PluginDiagnostic` carrying the spec section it enforces.
Diagnostics are exposed on the layer (`provides.diagnostics`) and mirrored onto
the execution trace as `agent-plugins.diagnostic` events. §11.3 rule 4 says
clients SHOULD report; silent skipping is the failure mode that requirement
exists to prevent.

## Path containment (§4.1)

Containment is decided on `realpath` output, never on lexical normalization. A
symlink may point outside the plugin directory, so `skills/x` can lexically
look contained while resolving to `/etc`. A path that cannot be resolved is
treated as *not* contained — the check fails closed.

The root is resolved too. Comparing a resolved child against an unresolved
parent reports false escapes wherever the root itself sits behind a symlink.

A path whose leaf does not exist yet resolves through its nearest existing
ancestor, so a client can containment-check a directory it is about to create
(a `PLUGIN_DATA` subdirectory) without weakening the symlink guarantee.

## MCP servers

`mcp.json` is a closed union over three transports. Validation and resolution
are separate concerns: validation is pure, while resolution touches the
filesystem to enforce containment on `command` and `cwd`.

Rules that JSON Schema cannot express, and that this client enforces:

- `command` is a single executable token — a bare name or a `./` path — never a
  shell command string, and never placeholder-expanded (§7.2.1).
- `cwd` takes exactly three forms: `./…`, `${PLUGIN_ROOT}[/…]`, or
  `${PLUGIN_DATA}[/…]`. A `${PLUGIN_DATA}`-rooted value is contained against the
  data directory — the one legal package path that points outside the root.
- `url` is absolute http(s) with no user information and no fragment; plain
  HTTP is permitted only for loopback hosts.
- Header names are case-insensitive, so the same name under two casings is an
  ambiguity the client cannot resolve and invalidates the entry.
- `env` must not declare `PLUGIN_ROOT` or `PLUGIN_DATA` (§9.2).

### Transports

`stdio` and `streamable-http` are enabled by default. `sse` is implemented but
off by default: §7.2.1 makes it OPTIONAL and it is the deprecated 2024-11-05
transport, so opting in should be deliberate. An entry declaring a transport
the host has not enabled is skipped, not an error (§7.2.2 rule 4).

### Subprocess environment (§9.1)

The ordering is normative and load-bearing:

1. a client-selected base environment,
2. the plugin's configured `env`, expanded, overlaid on top,
3. `PLUGIN_ROOT` and `PLUGIN_DATA` set **last**, replacing anything with those
   names.

Setting the reserved variables last is what makes them un-spoofable: validation
already rejects an entry that declares them, and the ordering means even a
bypass could not win.

The base environment is a narrow allowlist — `PATH` (for the platform
executable search that §7.2.1 leaves client-defined) plus the platform-shape
variables a process needs to start. §9.1 permits a client to omit or sanitize
ambient variables and forbids a conforming plugin from depending on any the
spec does not require, so passing the agent's whole environment — API keys
included — to every plugin subprocess would leak secrets for no conformance
benefit.

That allowlist is not the whole story, and the difference matters to anyone
reasoning about isolation: the MCP SDK's stdio transport unconditionally merges
its own `getDefaultEnvironment()` into the child environment, so a subprocess
also receives `HOME`, `SHELL`, `USER` and similar regardless of what is passed
here. The SDK exposes no way to suppress that. What the allowlist does
guarantee is that nothing from the *agent's* configuration — API keys,
provider credentials — is forwarded, and that the reserved variables are still
applied last.

`PLUGIN_DATA` is created and resolved before its value can be substituted
anywhere, since §9.1 defines it as an absolute, filesystem-resolved path. It is
not created for a plugin that declares no MCP servers: discovery must not have
side effects for a plugin that will never launch a subprocess.

### Expansion (§9.2)

A single left-to-right pass replaces `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in
`args` elements, `env` *values*, and `cwd`. Replacement text is never rescanned,
so a substituted value that itself looks like a placeholder stays literal.
Nothing else expands — not `env` keys, not `command`, not `url` or headers.

## The `agentPlugins()` layer

```ts
agentPlugins({
  roots: readonly string[],      // directories to scan
  dataDir: string,               // base for per-plugin PLUGIN_DATA
  transports?: McpTransport[],   // default: stdio + streamable-http
  connectMcp?: boolean,          // default: true
  baseEnv?: Record<string, string | undefined>,
  slot?, scope?, budget?,
})
```

- **Slot** `Slot.PROCEDURAL` — skills are procedural knowledge.
- **Scope** `'thread'` — the plugin set is fixed for the process, but which
  skills are active is conversation state and must survive resume.
- **Placement** `'anchor'` — the index is byte-identical every turn, so it
  belongs in the cached prefix.

### Progressive disclosure

The Agent Skills spec prescribes three tiers, mapped onto the layer:

| Tier | Content | Mechanism |
|---|---|---|
| 1. Metadata | Every skill's `name` + `description` (~100 tokens each) | `recall` output, every turn |
| 2. Instructions | The `SKILL.md` body | `loadSkill`, then pinned for the thread |
| 3. Resources | `scripts/`, `references/`, `assets/` files | `readSkillResource`, one at a time |

Activation is the only thing that changes the rendered block, which is the case
`renderDelta` exists for. The hook republishes the block **in full**: the
runtime publishes a delta under `action="replace"`, whose header tells the model
the new block supersedes the earlier one with the same layer id, so emitting
only the newly activated skill would silently retract the index and every
earlier activation. The saving is not payload size but cache stability — the
anchored prefix stays byte-identical and the correction is appended.

In practice the runtime seldom marks this layer's pin stale, so `renderDelta`
rarely fires and the anchor is usually rewritten in place. That is runtime
anchoring behavior rather than something this layer controls.

Under budget pressure the layer sheds the **oldest** activated body first, then
the next, and only trims the index as a last resort — the index is what lets
the model know a skill exists at all. A zero budget fails open rather than
deleting the block, matching `staticContent` and `openUiSurface`.

### State and ownership

Layer state holds only `activated: string[]`. The discovered index and the live
MCP sessions live on the layer instance: the index is identical for every
thread and would be pure duplication in durable storage, and a session is a
live subprocess or socket that cannot be serialized at all.

Discovery runs once per layer instance and is shared by every scope that inits
against it — rescanning per thread would relaunch every stdio server. Sessions
are closed on the last scope's `dispose`.

A spawned child inherits the parent's activations but its own do not merge
back. Activation says what *this* conversation is working from; a child that
consulted a skill to answer one question should not permanently pin those
instructions into the parent.

### Exposed surface

`provides` data: `plugins`, `skills`, `mcpServers`, `mcpTools`, `diagnostics`,
`activeSkills`.

`provides` functions, which the runtime also exposes to the model as tools:

- `loadSkill({ skill })` — body plus a bundled-resource listing. A bare skill
  name resolves when exactly one plugin provides it; when two do, the call
  reports the candidates rather than guessing, since guessing would silently
  run the wrong instructions.
- `readSkillResource({ skill, path })` — contained against the *skill*
  directory, which is stricter than §4.1 requires and stops one skill reading
  another's files.
- `callMcpTool({ server, tool, arguments })` — registered only when
  `connectMcp` is enabled, so a skills-only host does not carry a dead tool.

A failing tool call returns a result the model can react to rather than
throwing, which keeps a misbehaving server from unwinding the agent's turn.

## Client extensions (§8)

Noetic claims the reverse-domain namespace `tools.noetic`. Its semantics are
deliberately pass-through: `extensions['tools.noetic']` and the contents of a
`tools.noetic/` directory are surfaced verbatim on `LoadedPlugin`. Fixing a
format now would lock in a contract before anything consumes it.

Namespaces this client does not implement are ignored **without** validating
their contents, as §11.1 rule 3 requires.

## Conformance

`packages/agent-plugins/test/conformance.test.ts` walks the Appendix A
checklist, driven by real plugin trees in temp directories — the only way to
exercise symlink containment honestly. Coverage is spread across the suite
rather than one test per box: `mcp-config.test.ts` carries most of the `cwd`,
URL, and header rules, and `paths.test.ts` the containment cases. All 19 boxes
have direct coverage.

Two of them needed care to test rather than merely appear tested:

- The §9.1 **ordering** cannot be exercised through the public path, because
  validation rejects any entry declaring a reserved variable. It is tested by
  calling `buildSubprocessEnv` directly with a synthetic server that declares
  `PLUGIN_ROOT`, so the assertion fails if the spread order is reversed. The
  earlier test only proved both names were present, which a reversed spread
  would also satisfy.
- Transport selection is proven by a loopback server observing the request,
  not by inspecting which transport class was constructed.

`test/hardening.test.ts` carries the regressions from the adversarial review:
containment failing closed, prompt-block integrity, delta completeness,
frontmatter openness, header precedence, and the lifecycle cases.

Live stdio MCP behavior is covered end-to-end against a fixture server that
echoes back the environment it was launched with, so `PLUGIN_ROOT` and
`PLUGIN_DATA` are observed inside a real subprocess.

## Failure isolation is load-bearing, and bounded

Two limits exist because a plugin is third-party code that can be hostile or
merely broken:

- **Every MCP connection is bounded** (`DEFAULT_CONNECT_TIMEOUT_MS`). A server
  that opens its pipe and never answers `initialize` would otherwise hang
  `connect()` forever, and with it the layer's `init` — which the runtime
  resolves by *throwing*, aborting the whole agent execution and orphaning
  every subprocess started alongside it. Servers connect concurrently, so the
  timeout also bounds the whole connect phase rather than being multiplied by
  the server count.
- **Sizes are capped**: a `SKILL.md` is size-checked before it is read, since
  its body is retained for the process lifetime and returned by `loadSkill` as
  a single tool result, and the number of declared MCP servers is capped
  because each one costs a process spawn.

The layer declares `onInitError: 'disable'`. Plugins are enrichment, not
load-bearing context: if discovery fails outright the right outcome is an agent
with no skills and a diagnostic, not a dead execution.

## Future considerations

- **Client-extension semantics.** When a consumer for `tools.noetic/` exists,
  define its format here. Candidates: context-layer modules, step definitions,
  tool manifests.
- **Component types beyond v1.** The spec's design notes list commands, hooks,
  agents, rules, and LSP servers as deferred until their formats converge. If a
  future spec version standardizes any of them, they land as new discovery
  functions and new `provides` entries.
- **Prompts and resources.** MCP servers can expose prompts and resources in
  addition to tools. Only tools are surfaced today.
