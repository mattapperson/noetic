# 36 — Noetic Tools in ACP Agents

> **Depends On:** `02-step-variants` (Lazy, callModel tools), `08-runtime` (events, drains, steering, approval), `10-observability` (spans), `26-json-workflow-runtime` (the `acp-agent` node), `27-acp-agent-steps` (ACP steps, sessions, permissions), `34-custom-items` (`decorateResultItem`, item schemas)
> **Exports:** `AcpTool`, `bridgedToolTitles`, `AcpToolCall`, `AcpToolResult`, `AcpToolHost`, `AcpClientHost.tools`, `AcpAgent.servesTools`, `StepAcpAgent.tools` (types); `step.acpAgent({ tools })`, `acpAgentTool({ tools })` (core); `AcpToolWiring`, `ToolBridgeAddress`, `ToolBridgeLaunch`, `claudeToolWiring`, `codexToolWiring`, `opencodeToolWiring`, `sessionToolWiring`, `AcpPresetOptions.tools`, `DefineAcpAgentOptions.tools` (acp); `createToolServer`, `agentCallIdOf` (`@noetic-tools/mcp`), `serveToolsOverHttp`, `HttpToolServer` (`@noetic-tools/mcp/node`)

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
records the same items, events, spans, approvals, and layer-state writes.

## Pieces

| Piece | Package | Job |
|---|---|---|
| Tool call pipeline | `core` (`runtime/tool-call.ts`) | `executeToolCall` — steering on raw args, validation, `needsApproval`, execution, stringify — and `createToolResultItem`. Shared by the `callModel` tool loop and the ACP tool runner. |
| Tool runner | `core` (`interpreter/acp-tools.ts`) | Builds the tool listing and implements `AcpToolHost.call` with the step's `ctx`, layers, and event bridge. |
| Contract | `types` | `AcpToolHost` on `AcpClientHost.tools`; `AcpAgent.servesTools`. Core never imports `acp` or `mcp`. |
| Tool bridge | `acp` (`tool-bridge.ts`, `tool-wiring.ts`, `tool-permissions.ts`) | Starts the server for a connection, applies the agent's settings, answers the agent's permission requests for bridged tools. |
| MCP server | `@noetic-tools/mcp` | `tools/list` and `tools/call` over the host; loopback streamable HTTP at `./node`. The only server-side user of the MCP SDK. |

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

The listed set is what a `callModel` step's model may call: the step's tools,
plus the context layers' tools when the run has no unified tool set. The same
tool object given twice is one tool. A root that is an object, or a union whose
every branch is an object, is listed as is; any other root is wrapped, with its
`definitions`/`$defs` lifted to the wrapper so refs still resolve.

Server tools (`ServerToolSpec`) are `ACP_SERVER_TOOL`: only a model provider can
run them. Eager `tools` and `mcpServers` are checked when the step is built,
getters when it runs.

## A call

`AcpToolRunner.call` queues calls and runs one at a time, in arrival order, as
the `callModel` loop does. For each call:

1. Hold for a drain (`drainsOf(ctx).hold`).
2. If the step is aborted, or the agent cancelled the call before it started,
   answer `Error: the step was cancelled before this tool call ran.` and run
   nothing — the `callModel` loop likewise starts no call once aborted.
3. Resolve the `callId` (below), emit `tool_round_started { round, toolCount: 1 }`.
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

`callId` is the agent's own id for the call, so events, the approver, the span,
and the items carry the id the agent's own records use:

1. from the MCP request `_meta` when the agent sends one
   (`_meta["claudecode/toolUseId"]` from Claude Code, `_meta.callId` from
   Codex); it equals the `toolCallId` of the agent's ACP `tool_call`;
2. otherwise from the first unclaimed `tool_call` the agent announced with an
   exact bridged title for the tool (opencode). The call arrives over MCP and
   its announcement over ACP, so a call that beats its announcement waits
   50 ms for it;
3. otherwise a fresh id.

A call the agent cancels while it runs runs to completion and is recorded, as an
in-flight `callModel` call is when its round is aborted; tools take no abort
signal.

If the pipeline itself throws — a result item that fails its schema, a layer
hook configured to throw — rather than the tool, the agent gets an
`Error: <message>` result, the turn is cancelled, and the step fails with that
error once the turn unwinds, as a `callModel` step fails on it.

When the turn ends the runner is unbound: a late call answers
`Error: unknown tool '<name>'`.

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

## Permissions

A bridged call is gated by steering and `needsApproval` when it reaches the
bridge, exactly as in `callModel`. The agent's own `session/request_permission`
for it is a gate `callModel` never has, so the ACP client answers it with the
`allow_once` option (else `allow_always`) without consulting the step's
`permissions`, steerer, or handler. `permissions` governs only the agent's own
tools.

Because the answer skips the policy, the match is exact. A request is for a
bridged tool when its title, or the title of the agent's earlier `tool_call` with
the same `toolCallId`, is one of `bridgedToolTitles(server, name)` for a listed
tool — and a `<server>_<name>` title is never an `execute`-kind call, since
opencode titles a shell command by its command line. Fields the model chooses,
like `rawInput`, never count. Codex sends only the `toolCallId`, so the client
keeps each announced `tool_call` by id until it settles.

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
| Claude Code | `session` | listing `_meta` (above); `MCP_TOOL_TIMEOUT` raised to the timer maximum |
| Codex | `launch` | `CODEX_CONFIG.mcp_servers` declares the bridge with `omit_tools_from: ["code_mode", "deferred"]`, `default_tools_approval_mode: "approve"`, no call timeout, and an unbounded `output_token_limit` per tool, plus the user's own MCP servers; `session/new` carries none. `shell_environment_policy.exclude` gains `CODEX_CONFIG`, so the token and server env never reach commands Codex runs |
| opencode | `session` | `OPENCODE_CONFIG_CONTENT.tool_output` limits lifted |
| Gemini CLI | `session` | none |
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

The agent reads its tool list once, so `tools` are fixed when the session is
created (`AcpLiveSession.tools`). A step reusing a session with a different
listing is `ACP_SESSION_SETTING_CONFLICT`. A step that gives no `tools` gets
none, even on a session another step opened with tools: the host's `tools` is
unbound and calls answer as unknown tools.

## Workflow JSON

The `acp-agent` node takes `tools` as the same `{ type: "<registered-tool-name>" }`
entries a `callModel` node takes, resolved from `HydrationContext.tools`.

## Future Considerations

- **MCP over ACP.** ACP's experimental `mcpCapabilities.acp` lets the agent send
  MCP requests over the ACP connection itself, removing the loopback server.
  Prefer it once agents advertise it; it needs the ACP library moved to
  `@agentclientprotocol/sdk`.
- **Tool-owned context layers.** A tool's `context` layer renders into a
  `callModel` prompt; ACP prompts carry no layer rendering yet.
- **Replay.** A replayed ACP step re-runs its tool calls; recording each
  bridged call in the step ledger would serve the recorded result instead.
- **Gemini CLI settings**, once its MCP behaviour is measured.
- **Steers.** A `callModel` step offers queued steers before each tool call and
  can skip the rest of a round. ACP steps take no steers yet, so bridged calls
  have no steer point.
