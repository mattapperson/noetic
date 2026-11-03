# 36 — Noetic Tools in ACP Agents

> **Depends On:** `02-step-variants` (Lazy, callModel tools), `08-runtime` (events, drains, steering, approval), `11-context-layer-system` (recall, store, after-call hooks), `10-observability` (spans), `26-json-workflow-runtime` (the `acp-agent` node), `27-acp-agent-steps` (ACP steps, sessions, permissions), `34-custom-items` (`decorateResultItem`, item schemas)
> **Exports:** `AcpTool`, `bridgedToolTitles`, `namesBridgedToolCall`, `geminiToolNameMatches`, `AcpToolCall`, `AcpToolResult`, `AcpToolHost`, `AcpClientHost.tools`, `AcpAgent.servesTools`, `StepAcpAgent.tools` (types); `step.acpAgent({ tools })`, `acpAgentTool({ tools })` (core); `AcpToolWiring`, `ToolBridgeAddress`, `ToolBridgeLaunch`, `claudeToolWiring`, `codexToolWiring`, `opencodeToolWiring`, `sessionToolWiring`, `BridgedPermissionCheck`, `claudeBridgedPermission`, `codexBridgedPermission`, `geminiBridgedPermission`, `geminiToolWiring`, `AcpPresetOptions.tools`, `DefineAcpAgentOptions.tools` (acp)

---

## Purpose

One set of tools for models and coding agents. A `tool()` given to
`step.callModel` works unchanged when given to `step.acpAgent`:

```ts
step.callModel({ id: 'a', model, tools: [search] });
step.acpAgent({ id: 'b', agent: claudeCode(), prompt, tools: [search] });
```

The agent reaches the tools over MCP. Every call runs the `callModel`
tool-call pipeline, so for the same tool, arguments, layers, and approver, the
agent's model receives the exact string a `callModel` model would, and the host
records the same items, events, spans, approvals, and layer-state writes. The
step's context layers run around each agent turn as they run around each model
call (see Layers).

## Pieces

| Piece | Package | Job |
|---|---|---|
| Tool call pipeline | `core` (`runtime/tool-call.ts`) | `executeToolCall` — steering on raw args, validation, `needsApproval`, execution, stringify — and `createToolResultItem`. Shared by the `callModel` tool loop and the ACP tool runner. |
| Tool runner | `core` (`interpreter/acp-tools.ts`) | Builds the tool listing and implements `AcpToolHost.call` with the step's `ctx`, layers, and event bridge. |
| Contract | `types` | `AcpToolHost` on `AcpClientHost.tools`; `AcpAgent.servesTools`. Core never imports `acp`. |
| Tool bridge | `acp` (`tool-bridge.ts`, `tool-wiring.ts`, `tool-permissions.ts`) | Starts the server for a connection, applies the agent's settings, answers the agent's permission requests for bridged tools. |
| MCP server | `acp` (`mcp/server.ts`, `mcp/node.ts`) | `tools/list` and `tools/call` over the host, on `@modelcontextprotocol/server`; loopback streamable HTTP on `@modelcontextprotocol/node` (hono, no express). `node.ts` needs `node:http`, so the bridge loads it on first use and the `.` entry stays runtime-neutral. |

## Tool listing

Each tool becomes one MCP tool:

- **Name** — `sanitizeToolNameForWire(tool.name)` (`[A-Za-z0-9_-]`), the name a
  model sees. Two tools with the same wire name are `ACP_TOOL_NAME_COLLISION`.
- **Input schema** — `resolveWireJsonSchema`, as for a model. A schema whose
  root is not an object is carried as `{ value: <schema> }` (MCP requires an
  object root) and unwrapped before validation.
- **Title** — `tool.acp.title` when it is a string.
- **No output schema** — an MCP client must validate `structuredContent`
  against one; Noetic never validates tool output.
- **`_meta`** — `anthropic/alwaysLoad: true` and
  `anthropic/maxResultSizeChars`, so Claude Code lists the tool up front and
  hands the model its whole result.

The listed set is what a `callModel` step's model may call, with the same
`tools` semantics:

- `tools: []` — none;
- `tools` given — those tools, plus the context layers' tools when the run has
  no unified tool set;
- no `tools` — every tool the run offers (the unified tool set, or the layers'
  tools when there is none).

The first tool of each name wins, as in the `callModel` set. An `acpAgentTool`
never reaches the step it runs: the agent calling it would wait on its own
session. With no `tools`, an agent that cannot take tools (`servesTools` unset)
gets none rather than failing.

An object root is listed as is. Any other root — a scalar, an array, a
nullable, or a union (Anthropic rejects `oneOf`/`anyOf`/`allOf` at the top of
a tool schema) — is wrapped, with its `definitions`/`$defs` lifted to the
wrapper and `$ref`s into the old root moved with it, so every ref resolves.

Server tools (`ServerToolSpec`) are `ACP_SERVER_TOOL`: only a model provider can
run them. Eager `tools` and `mcpServers` are checked when the step is built,
getters when it runs.

## A call

`AcpToolRunner.call` queues calls and runs one at a time, in arrival order, as
the `callModel` loop does. For each call:

1. Hold for a drain (`drainsOf(ctx).hold`), and resolve the `callId` (below).
2. If the step is aborted, an earlier call's pipeline has thrown, or the agent
   cancelled the call before it started, answer `Error: the step was cancelled
   before this tool call ran.` and run nothing — the `callModel` loop likewise
   starts no call once aborted or failed.
3. Emit `tool_round_started { round, toolCount: 1 }`.
   ACP exposes no model rounds, so each call is its own round, numbered from 0
   per turn.
4. Open a `tool.call` span under the step span (`tool.name`,
   `tool.needs_approval`, `tool.approval`).
5. Emit `tool_call_started { name, callId }`.
6. `executeToolCall` with the step's `ctx`, harness, and layers.
7. Build the `function_call` and the `function_call_output`
   (`createToolResultItem`, validated against the harness's item schemas
   extended by the tool's own, as in `callModel`; `decorateResultItem`).
8. Emit `item_appended` (unfiltered), `tool_call_completed { name, callId, error,
   output }`, and `tool_round_completed`.
9. Answer the agent: one `text` part holding the output, `isError` from `error`.
   A tool with no result (`undefined`) reaches the agent, like a model, as an
   empty string.

`callId` is the agent's own id for the call, so events, the approver, the span,
and the items carry the id the agent's own records use:

1. from the MCP request `_meta` when the agent sends one
   (`_meta["claudecode/toolUseId"]` from Claude Code, `_meta.callId` from
   Codex); it equals the `toolCallId` of the agent's ACP `tool_call`;
2. otherwise from the first unclaimed `tool_call` the agent announced for the
   tool — by exact bridged title (opencode) or by Gemini CLI's id
   `mcp_<server>_<tool>__call_<n>` (`namesBridgedToolCall`). The call arrives over MCP and
   its announcement over ACP, so a call that beats its announcement waits
   50 ms for it;
3. otherwise a fresh id.

A call the agent cancels while it runs, or one still running when the agent
ends its turn, runs to completion and is recorded: the turn ends only once the
runner is idle, as an in-flight `callModel` call belongs to its aborted round.
Tools take no abort signal.

If the pipeline itself throws — a result item that fails its schema, a layer
hook configured to throw — rather than the tool, the agent gets an
`Error: <message>` result, the turn is cancelled, and the step fails with that
error once the turn unwinds, as a `callModel` step fails on it.

When the turn ends the runner is unbound: a late call answers
`Error: unknown tool '<name>'`, and a late pipeline error affects no later turn.

## Items

The agent reports each call as an ACP `tool_call`, which the turn accumulator
turns into a `function_call` named by the agent's display title. After the turn,
`mergeBridgedItems` puts the bridge's pair in its place, keeping the bridge's
`callId`:

1. the unclaimed `function_call` with the bridge's `callId`;
2. otherwise the first unclaimed `function_call` whose title is exactly one of
   `bridgedToolTitles(server, wireName)` — `mcp__noetic__<name>`,
   `mcp.noetic.<name>`, `noetic_<name>`;
3. a call the agent never reported is appended.

On the event stream, a bridged `tool_call` is named by its wire name, as the
`callModel` stream names calls, and a bridge pair that took the place of an
agent record with another id is not announced twice.

## Permissions

A bridged call is gated by steering and `needsApproval` when it reaches the
bridge, exactly as in `callModel`. The agent's own `session/request_permission`
for it is a gate `callModel` never has, so the ACP client answers it with the
`allow_once` option (else `allow_always`) without consulting the step's
`permissions`, steerer, or handler. `permissions` governs only the agent's own
tools.

Because the answer skips the policy, an agent's requests are recognized only
by fields its own adapter sets, never by a title alone — some agents title a
call with text the model wrote (a subagent's description), which could spell a
bridged tool's name. Each wiring carries its agent's check
(`AcpToolWiring.permits`):

| Agent | Recognized by |
|---|---|
| Claude Code | `_meta.claudeCode.mcpServer.name` is the server and `_meta.claudeCode.toolName` is `mcp__<server>__<tool>` for a listed tool |
| Codex | the request's `_meta.is_mcp_tool_approval`, and the `tool_call` announced under the same id carrying `_meta.is_mcp_tool_call` and the title `mcp.<server>.<tool>` for a listed tool |
| Gemini CLI | its `toolCallId`, `mcp_<server>_<tool>__call_<n>`, which Gemini builds from the registered tool name (its title is display text); a long name it shortens with `...` matches by its start and end |
| opencode, `customAcpAgent` | nothing: requests go to the step's policy (opencode asks none by default) |

Codex sends only the `toolCallId`, so the client keeps each announced
`tool_call` by id until it settles (at most 1,000).

## Layers

A model receives the step's context layers in its request; an agent takes only
a prompt. So around each turn the step does what `callModel` does around each
model call:

1. The prompt joins the item log through the layers' append pipeline.
2. Before each turn, recall runs (budgeted as for `callModel`) and its output
   leads the prompt as a `<context>…</context>` block.
3. After the turn, the `afterModelCall` hooks see the turn's result. `deny`
   fails the step with `steering_denied`; `guide` sends one more turn carrying
   the guidance (up to the `callModel` retry limit), with the guidance logged as
   a developer message — the agent keeps its earlier answer in its own history,
   so it stays in the log too.
4. The `store` hooks see the final turn's result.

A tool's own `context` layer is one of these, so its recall reaches the agent
as it reaches a model.

## Nested runs

A tool may run a step on its own context (`toolCtx.harness.run(step, x,
toolCtx.ctx)`; `acpAgentTool` does). When the outer step was started by a bare
`execute()`, that run joins it: the context's layers are not re-initialized,
and nothing the outer run still uses — channels, ACP sessions — is closed when
the nested run returns.

## Transport and lifetime

- The server listens on `127.0.0.1` at a random port and path. Every request
  must carry the connection's bearer token (compared in constant time), a `Host`
  naming that port, and no `Origin` (the MCP guard against DNS rebinding). Only
  a `POST` may open an MCP session; an unknown session id is `404`, and a
  transport the request did not initialize is closed at once.
- One server per agent **connection**, started in `connect` before the agent
  process spawns and closed with the connection. It reads `host.tools` on every
  request, so rebinding the host between turns takes effect at once.
- The MCP server name is `noetic`. A user MCP server named `noetic` or
  `noetic_…` would give titles the bridge's could be taken for, so it is
  `ACP_TOOL_SERVER_NAME_CONFLICT`.
- An agent advertising no `mcpCapabilities.http` fails the existing capability
  check.

## Agent wiring

`AcpToolWiring` says where the bridge is declared and what launch settings
remove the agent's own differences from `callModel`:

| Agent | `declare` | Settings |
|---|---|---|
| Claude Code | `session` | listing `_meta` (above); `MCP_TOOL_TIMEOUT` raised to the timer maximum and `MAX_MCP_OUTPUT_TOKENS` lifted, unless already set |
| Codex | `launch` | `CODEX_CONFIG.mcp_servers` declares the bridge with `omit_tools_from: ["code_mode", "deferred"]`, `default_tools_approval_mode: "approve"`, no call timeout, and an unbounded `output_token_limit` per tool, plus the user's own MCP servers; `session/new` carries none. `shell_environment_policy.exclude` gains `CODEX_CONFIG`, so the token and server env never reach commands Codex runs |
| opencode | `session` | `OPENCODE_CONFIG_CONTENT.tool_output` limits lifted |
| Gemini CLI | `session` | `GEMINI_CLI_TRUST_WORKSPACE=true` unless the host already set it: Gemini starts no MCP server in an untrusted folder. Tools are listed up front and output arrives whole as is |
| pi | — | cannot take tools: `pi-acp` ignores MCP servers |

Codex is `launch` because codex-acp replaces `CODEX_CONFIG.mcp_servers` with the
servers in `session/new` and builds those from address fields only. Launch
settings merge into the agent's existing `CODEX_CONFIG` /
`OPENCODE_CONFIG_CONTENT`.

A preset given a custom `transport` takes no tools unless `tools: true`: the
agent may not reach this machine's loopback interface. `customAcpAgent` takes
`tools` the same way, with `sessionToolWiring`. A step that gives tools to an
agent without `servesTools` is `ACP_TOOLS_UNSUPPORTED`, at build time for an
eager agent.

## Sessions

The agent reads its tool list once, so the session's list is fixed when it is
created (`AcpLiveSession.tools`). A step reusing the session may serve any part
of that list — a call to a listed tool outside its part answers as an unknown
tool, as on `callModel` — but a tool the list lacks, or lists differently, is
`ACP_SESSION_SETTING_CONFLICT`, naming the tools. A step that serves no tools
on a session opened with tools leaves the list in place and answers every call
as an unknown tool.

## Workflow JSON

The `acp-agent` node takes `tools` as the same `{ type: "<registered-tool-name>" }`
entries a `callModel` node takes, resolved from `HydrationContext.tools`.

## Future Considerations

- **MCP over ACP.** ACP's experimental `mcpCapabilities.acp` lets the agent send
  MCP requests over the ACP connection itself, removing the loopback server.
  Prefer it once agents advertise it; it needs the ACP library moved to
  `@agentclientprotocol/sdk`.
- **Replay.** A replayed ACP step re-runs its tool calls; recording each
  bridged call in the step ledger would serve the recorded result instead.
- **Steers.** A `callModel` step offers queued steers before each tool call and
  can skip the rest of a round. ACP steps take no steers yet, so bridged calls
  have no steer point.
