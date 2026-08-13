# Noetic API Reference

## Builder Functions

### runCode

Pure async computation. The runtime can retry freely and doesn't track token usage.

```typescript
runCode<TContext = ContextData, I = unknown, O = unknown>({
  id: string;
  execute: (input: I, ctx: Context<TContext>) => Promise<O>;
  retry?: RetryPolicy;
  subprocess?: SubprocessAdapter; // per-step adapter override
}): StepRunCode<TContext, I, O>
```

The optional `subprocess` field makes this specific step run through a different adapter — e.g. `createLocalSubprocessAdapter({storage})` from `@noetic-tools/platform-node` for an out-of-process child, or an in-memory test double for unit tests. Resolution order at dispatch time is `detachedSpawn-overrides.subprocess ?? step.subprocess ?? harness.subprocess`. When omitted, the step uses the harness default.

### callModel

Model call with optional tools and structured output.

```typescript
type Lazy<T, TContext = ContextData> =
  | T
  | ((ctx: Context<TContext>) => T | Promise<T>);

callModel<TContext = ContextData, I = unknown, O = unknown>({
  id: string;
  model: Lazy<string, TContext>;                    // eager string or (ctx) => string
  instructions?: Lazy<string | undefined, TContext>;
  tools?: Lazy<Tool[] | undefined, TContext>;       // allowed tool subset (undefined = all, [] = none)
  output?: StandardSchemaV1<unknown, O> | OutputCodec<O>;  // any Standard Schema v1 (Zod default) OR a streaming codec (see Generative UI)
  outputJsonSchema?: Record<string, unknown>;            // explicit fallback/override after Zod and StandardJSONSchemaV1
  params?: ModelParams;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}): StepCallModel<TContext, I, O>
```

`tools` specifies which tools the model may invoke for this step. Before execution, the harness collects all tools from every `callModel` step in the tree into a unified set. Every LLM call sends the full set (preserving prompt cache), while `tools` narrows the allowed subset via `tool_choice: { type: "allowed_tools" }`. Omit `tools` to allow all; set `tools: []` to disable tools for the step.

**Lazy params.** `model`, `instructions`, and `tools` each accept either an eager value or a `(ctx) => value` getter resolved at step execution. Getters see the live `Context`, so a step can read `ctx.harness.config.params` or `ctx.unifiedTools` to produce per-run values without baking them in at build time. Function-form `tools` are NOT walked by `collectAllTools`; tools needed in the harness-wide pool should be registered via `AgentHarness.tools`. Eager `model` strings are validated at build time (empty → `MISSING_MODEL`); function-form models are validated after resolution with the same error code.

```typescript
callModel({
  id: 'plan-chat',
  model: (ctx) => ctx.harness.config.params.model as string,
  instructions: (ctx) => composeInstructions(ctx),
  tools: (ctx) => (ctx.unifiedTools ?? []).filter((t) => PLAN_MODE_TOOL_NAMES.has(t.name)),
});
```

**Generic-param order.** The signature is `callModel<TContext, I, O>`, NOT `<I, O>`. Writing `callModel<string, unknown>(...)` silently sets `TContext = string`, which yields misleading errors when the step is composed into a harness whose context shape is anything else. Either pass all three (`callModel<MyContext, string, string>(...)`) or pass none and let inference drive from the object literal.

**Lazy params disable eval-optimizer rewrites.** `@noetic-tools/eval`'s optimizer walks the step tree and swaps candidate strings into `instructions` / tool `name` / tool `description`. It skips fields whose value is a function because there is no way to substitute a string for a getter without dropping the getter's runtime logic. Use eager values for any field you want the optimizer to tune; reserve function-form only for fields that genuinely need per-execution context.

`emit` controls framework event emission (default `true`). Set `false` to suppress all, or pass a filter function.

`output` accepts any Standard Schema v1 schema (assistant text is JSON-parsed and validated; Zod runs `safeParse`, other validators run `~standard.validate` with sync/Promise support, and the parsed/transformed value is returned) OR an `OutputCodec<O>`. Model JSON Schema resolves through Zod's native converter, StandardJSONSchemaV1, then `outputJsonSchema`; the explicit field overrides the trait for non-Zod schemas and falls back when conversion throws. The OpenUI codec (`openUi(library)`) makes the model render a UI instead of returning text; see [Generative UI](#generative-ui-openui).

The agent harness assembles the View before calling the model: system message + context layer items + conversation history. The `instructions` field becomes an `InputMessageItem` with `role: system`.

`AgentHarness.execute` accepts a plain string, one item, or an item array. Use an `InputMessageItem` when the input needs structured content; its `content` array supports `input_text`, `input_image`, and `input_file` parts.

### invokeTool

Direct tool execution (not via LLM selection).

```typescript
invokeTool<TContext = ContextData, I = unknown, O = unknown>({
  id: string;
  tool: Tool<StandardSchemaV1<unknown, I>, StandardSchemaV1<unknown, O>>;
  args?: Partial<I>;
}): StepInvokeTool<TContext, I, O>
```

### conditional

Conditional routing. The `route` function returns a step to execute or `null` to pass through.

```typescript
conditional<I, O>({
  id: string;
  route: (input: I, ctx: Context) => Step<I, O> | null;
}): StepConditional<I, O>
```

### inParallel

Parallel execution with three modes.

```typescript
// Race: first to complete wins
inParallel<I, O>({ id, mode: 'race', paths: () => Step[] })

// All: wait for all, merge results
inParallel<I, O>({ id, mode: 'all', paths: () => Step[], merge: (results) => O })

// Settle: wait for all (including failures), merge
inParallel<I, O>({ id, mode: 'settle', paths: () => Step[], merge: (results: SettleResult[]) => O })
```

Each parallel path gets a deep clone of parent state. Mutations in one path don't affect siblings.

Each path is also a context child boundary: it inherits the parent's layers and tool pool, `onSpawn` seeds its per-path layer state (items from `onSpawn` are NOT appended — the path already has the parent's item log), and `onReturn` merges a *successful* path back. Merges are serialised across paths, so concurrent workers don't clobber one parent state.

### spawn

Child execution with context boundary. Context layers control what state crosses the boundary.

```typescript
spawn<TContext = ContextData, I = unknown, O = unknown>({
  id: string;
  child: Step<TContext, I, O>;
  context?: ContextConfig | ContextLayer[];
  timeout?: number;
  subprocess?: SubprocessAdapter; // per-step adapter override
}): StepSpawn<TContext, I, O>
```

Per-step `subprocess` mirrors `runCode` — use it to pin a specific spawn to an out-of-process adapter (real OS subprocess with durable handle manifests) or a test double (in-memory adapter that records the request for assertions). Resolution precedence is the same: `detachedSpawn-overrides.subprocess ?? step.subprocess ?? harness.subprocess`.

### loop

Iteration with termination predicates.

```typescript
loop<I, O>({
  id: string;
  steps: ReadonlyArray<Step<I, O>>;
  until: Until;
  maxIterations?: number;
  inbox?: Channel<string>;
  parkTimeout?: number;
  prepareNext?: (output: O, verdict: Verdict, ctx: Context) => I;
}): StepLoop<I, O>
```

### schedule

Schedule a step on a fixed interval, optionally woken sooner by a channel message. The operator runs forever until the executing context is aborted; cancellation flows through `harness.abort` and interrupts the parking promise immediately.

```typescript
schedule<I, O>({
  id: string;
  step: Step<I, O>;
  interval: number;                    // period, start-to-start
  inbox?: Channel<unknown>;            // any message cuts the wait short
  onError?: 'continue' | 'fail';       // default 'continue'
  jitter?: number;                     // default 0; ms ± randomized
}): StepSchedule<I, O>
```

`onError: 'continue'` (default) emits an `schedule.iteration.error` span event with the caught error attached, then re-loops — daemon-friendly. `onError: 'fail'` propagates and terminates the operator (and any enclosing `inParallel`). Returns `Step<I, void>` so it composes into `inParallel({ paths })` and `spawn({ child })` for orchestrating long-running scheduled work.

### tool

Typed tool factory with Standard Schema validation (Zod default, any Standard Schema v1 validator accepted).

```typescript
tool<I, O>({
  name: string;
  description: string;
  input: StandardSchemaV1<I>;
  output: StandardSchemaV1<O>;
  inputJsonSchema?: Record<string, unknown>;  // explicit fallback/override after Zod and StandardJSONSchemaV1
  execute: (args: I, toolCtx: ToolExecutionContext) => Promise<O>;
  needsApproval?: boolean;
  context?: ToolContextDeclaration;
  ui?: ToolUiDeclaration<I, O>;           // call/progress/result/error render fns (generative UI)
  itemSchemas?: ItemSchemaExtensions;     // { items?, developerMessages?, toolCalls?, toolResults? }
  decorateResultItem?: (params) => Item;  // enrich the harness-created tool-result item
}): Tool
```

`toolWithGenerator({ …, event, async *execute })` is the streaming form: it adds
the `event` schema and takes an async generator, and its `ui.progress(events)`
is typed from `event` (the non-generator `tool()` has no events to render).

**`itemSchemas` contract** — extension schemas are additive and owner-scoped:

- A tool's `toolResults` schemas validate ONLY that tool's own result items (strictly: a result matching none of them fails the round with `NoeticError` kind `item_schema_mismatch`). They never reject a sibling tool's results; tools without `itemSchemas` fall back to the base structural parse.
- Schemas are **gates, not normalizers**: on match the original item is returned unchanged (undeclared fields like the framework-generated `id`/`status` survive). Zod `.transform()` / `.default()` in extension schemas are unsupported.
- `decorateResultItem` output must satisfy the tool's own `toolResults` schemas — including for error outputs (e.g. malformed-arguments results), so declare error-shaped results or make decorated fields tolerant.
- Harness-level `itemSchemas.schemas` (on `AgentHarness` opts, an `ItemSchemaConfig` of `{ schemas?, strict? }`) stay global and apply to every item at trust boundaries.

### step.acpAgent

Delegates one turn to an external coding agent over the [Agent Client Protocol](https://agentclientprotocol.com/), the way `callModel` delegates a turn to a model. **One** `Step.kind` (`'acp-agent'`) covers every agent: the agent is passed in as an adapter, so supporting a new one never changes this API or the published workflow schema.

```typescript
step.acpAgent<TContext = ContextData, I = unknown, O = unknown>({
  id: string;
  agent: Lazy<AcpAgent, TContext>;                     // preset or custom adapter
  prompt?: Lazy<string, TContext>;                     // plain-text turn input ('' → use step input)
  content?: Lazy<ReadonlyArray<AcpContentBlock> | undefined, TContext>;  // image/audio/resource blocks
  mcpServers?: Lazy<ReadonlyArray<AcpMcpServer> | undefined, TContext>;
  cwd?: Lazy<string | undefined, TContext>;            // defaults to ctx.cwdState.cwd
  mode?: Lazy<string | undefined, TContext>;           // session/set_mode before the turn
  model?: Lazy<string | undefined, TContext>;          // session/set_model before the turn
  permissions?: AcpPermissionPolicy;
  onPermissionRequest?: AcpPermissionHandler;
  clientCapabilities?: AcpClientCapabilityConfig;
  output?: StandardSchemaV1<unknown, O>;               // structured output, like callModel
  session?: AcpSessionPolicy;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}): StepAcpAgent<TContext, I, O>
```

Agents come from `@noetic-tools/acp`. A preset is only a launch recipe — there is no vendor SDK:

```typescript
import { claudeCode, codex, gemini, customAcpAgent } from '@noetic-tools/acp';

const review = step.acpAgent({
  id: 'review',
  agent: claudeCode(),                                  // npx @zed-industries/claude-code-acp
  prompt: 'Review the staged diff and summarize the riskiest change.',
  mode: 'plan',
  permissions: { default: 'deny', allow: [{ kind: 'read' }] },
});
```

`codex()`, `gemini()`, and `customAcpAgent({ agentId, command, args, env, transport })` take the same shape. Every preset accepts `command` / `args` / `env` overrides plus a `transport` for non-stdio reach.

The interpreter mirrors `executeCallModel`: it appends the prompt as a user item, opens (or reuses) a connection + session, applies `mode`/`model`, drives one `session/prompt`, forwards each notification as an `acp_event` framework event, appends the turn's items to the item log, charges `ctx.tokens`/`ctx.cost`, records `ctx.lastStepMeta`, tears the connection down per policy, and returns the assistant text (or the parsed `output`).

**Client capabilities.** ACP inverts control: the agent asks the client to read/write files and run terminals. Noetic serves those from `ctx.fs` and `ctx.shell`, so a sub-agent's file and shell access is sandboxed and audited like a first-party step. `clientCapabilities` withdraws one — the agent is then told the method does not exist:

```typescript
interface AcpClientCapabilityConfig {
  readTextFile?: boolean;   // fs/read_text_file  (default true)
  writeTextFile?: boolean;  // fs/write_text_file (default true)
  terminal?: boolean;       // terminal/*         (default true)
  additionalDirectories?: ReadonlyArray<string>;  // reachable beyond cwd
  allowAnyPath?: boolean;   // lift confinement entirely (default false)
}
```

**Filesystem confinement.** `fs/*` paths are confined to the session cwd by default; outside paths, `..` traversal, name-prefix siblings (`/workspace-secrets` vs `/workspace`), and relative paths are all refused before reaching the `FsAdapter`. **A `permissions` policy does NOT do this** — it answers `session/request_permission`, which covers the agent's *tool calls*, while `fs/*` and `terminal/*` are client methods the agent calls directly. An agent that never asks is never gated by a policy. Limits: the check is lexical (a symlink inside the workspace pointing out is not caught), and `terminal/create` confines only the starting cwd — a command can `cd` anywhere, so `terminal: false` is the only hard boundary for shell access.

**Permissions.** `session/request_permission` resolves in three tiers, first decisive wins: the `permissions` policy, then steering's `beforeToolCall` (a **veto** tier — only a non-allow decision is acted on), then `onPermissionRequest`. When all abstain the policy `default` applies, and that default is `'deny'`.

```typescript
interface AcpPermissionPolicy {
  default?: 'allow' | 'deny' | 'cancel';   // defaults to 'deny'
  allow?: ReadonlyArray<{ kind?: AcpToolKind; title?: string | RegExp }>;
  deny?: ReadonlyArray<{ kind?: AcpToolKind; title?: string | RegExp }>;  // checked before allow
  persist?: boolean;                        // prefer allow_always / reject_always
}
```

**Session policy** (`AcpSessionPolicy`):

```typescript
interface AcpSessionPolicy {
  reuse?: string;                             // share a kept connection across steps by key
  keepAlive?: 'step' | 'run' | 'harness';     // default 'step' — closed when the step ends
  load?: string;                              // resume an existing ACP session id via session/load
}
```

A connection owns a live agent process, so **keeping one is always an explicit opt-in**: `keepAlive` defaults to `'step'`. `'run'` keeps it for the rest of the root run and the harness collects it; `'harness'` keeps it until the caller runs `await harness.closeAcpSessions()` — nothing closes that one for you, and leaving it open keeps the host process alive.

`reuse` requires `keepAlive: 'run'` or `'harness'` (a connection closed with its step has nothing to share); a reuse key without a scope throws `ACP_REUSE_WITHOUT_KEEPALIVE`. Per-turn state (`permissions`, `onPermissionRequest`, steering, the event stream) is rebound before every turn, so each step gets its own. `clientCapabilities` and the agent itself are connection-level: a step joining an existing session with different ones throws `ACP_SESSION_CAPABILITY_CONFLICT` / `ACP_SESSION_AGENT_CONFLICT`.

**Stop reasons:** `end_turn`, `max_tokens`, and `max_turn_requests` return normally (the reason lands on `ctx.lastStepMeta`); `refusal` throws `model_refused`; `cancelled` throws `cancelled`. Aborting the context sends `session/cancel`.

**Errors:** `EMPTY_STEP_ID` (empty `id`), `MISSING_ACP_AGENT` (no `agent`), `MISSING_PROMPT` (neither `prompt` nor `content`). Asking for a capability the agent did not advertise — `loadSession`, a mode, a model, image/audio/embedded content, an HTTP/SSE MCP server — throws `AcpCapabilityError` before anything reaches the wire; a failed handshake throws `AcpConnectError`.

**JSON workflow:** one node kind, `acp-agent`, with fields `agent` (registry key), `prompt`, and optional `cwd` / `mode` / `model` / `mcpServers` / `permissions` / `clientCapabilities` / `session`. Adapters resolve at hydration from `HydrationContext.acpAgents` (a `Map<string, AcpAgent>`); build it with `createAcpAgentRegistry(claudeCode(), codex())`. The registry is an **open** set — a new agent needs an entry, not a schema change. An unregistered key fails with `UNKNOWN_ACP_AGENT_REFERENCE`.

**Authoring an agent + testing.** The `AcpAgent` contract lives in `@noetic-tools/types` (next to `ContextLayer`); `@noetic-tools/core` depends only on the *type* and runs adapter *instances* you pass in — it never imports `@noetic-tools/acp` (enforced by `.sentrux/rules.toml`). Build an adapter with `defineAcpAgent({ agentId, transport })`. For tests, `loopbackTransport` stands an in-process agent on the far end of a **real** protocol connection, so the wire format is exercised without spawning anything:

```typescript
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

The Node stdio transport lives at `@noetic-tools/acp/stdio`, so the package's main entry stays runtime-neutral.

### acpAgentTool

Wraps an ACP agent as a `Tool`, so a `callModel` step can delegate by calling it. The model decides *when*; a step decides *for* it.

```typescript
acpAgentTool({
  agent: AcpAgent;                       // e.g. claudeCode()
  name?: string;                         // default `delegate_to_<agentId>`
  description?: string;                  // steer WHEN the model delegates
  cwd?, mode?, model?, mcpServers?, permissions?, onPermissionRequest?, clientCapabilities?,
  session?: AcpSessionPolicy;            // reuse + keepAlive → a conversation across calls
}): Tool  // input { prompt }, output { text }
```

Runs the same `step.acpAgent` via `harness.run` on the tool's own context, so the delegated turn lands in the same item log, usage totals, and event stream. Throws `MISSING_ACP_AGENT` with no adapter.

### Human-in-the-loop ACP permissions

`askUserForPermission()` (from `@noetic-tools/acp`) builds an `onPermissionRequest` handler that publishes to an external channel and parks for an answer — the same request/decision shape `@noetic-tools/chat-sdk` uses for tool approvals.

```typescript
import {
  ACP_PERMISSION_SCOPE, acpPermissionRequests, acpPermissionDecisions,
  askUserForPermission, resolveAcpPermission,
} from '@noetic-tools/acp';

step.acpAgent({ …, permissions: { default: 'deny' }, onPermissionRequest: askUserForPermission() });

// once per harness:
const decisions = harness.getChannelHandle(acpPermissionDecisions, ACP_PERMISSION_SCOPE);
for await (const p of harness.getChannelStream(acpPermissionRequests, ACP_PERMISSION_SCOPE)) {
  resolveAcpPermission(decisions, { requestId: p.requestId, decision: 'allow', optionId: p.options[0].optionId });
}
```

Requests are a queue (subscribe ONCE — a second subscriber steals them); decisions are a topic (broadcast, filtered by `requestId`). The handler parks before publishing, since topic delivery reaches only subscribers parked at send time. An unanswered prompt denies on timeout (5 min default; `askUserForPermission({ timeout, onTimeout })`). Because reaching a person means reaching a channel, `onPermissionRequest` receives `(request, ctx, info)` where `info` is `{ agentId, stepId }`.

### Live ACP session control

```typescript
harness.listAcpSessions(): AcpSessionInfo[]   // key, agentId, sessionId, keepAlive, mode, commands
harness.getAcpSession(key): AcpLiveSession | undefined
harness.cancelAcpSession(key): Promise<boolean>   // session/cancel; connection stays open
harness.closeAcpSessions(): Promise<void>         // release everything held; idempotent
```

Read-and-interrupt only: turns are driven by steps, so a turn started here would bypass the item log, usage accounting, and event bridge. Follow-ups go through a step sharing the `session.reuse` key.

### channel

Typed inter-step communication.

```typescript
channel<T>(name: string, {
  schema: ZodType<T>;
  mode: 'value' | 'queue' | 'topic';
  capacity?: number;
  external?: boolean;
}): Channel<T>
```

`ctx.send(channel, value)` returns `Promise<void>` (breaking change in core v(next)): it resolves immediately for value/topic channels and queue channels below capacity, and parks when a queue channel is full (back-pressure) — `channel_timeout` after 30s, `cancelled` if the context aborts while parked. Always `await` it. `ctx.recv` rejects with `cancelled` when the context is aborted while waiting. External `ChannelHandle.send` stays synchronous and drops the oldest item at capacity.

External channels (`external: true`) are reachable from outside the execution in both directions: `harness.getChannelHandle(ch, executionId)` writes in, `harness.getChannelStream(ch, executionId)` subscribes out as an `AsyncIterable<T>` (queue = competing consumer — subscribe once per harness; topic = per-subscriber buffered tap; value = current-then-conflated-updates). Delivery is CHANNEL-scoped (state keyed by name per harness); `executionId` bounds only the stream's lifetime, and an id no execution runs under gives a harness-lifetime stream ended with `iterator.return()`. The stream ends normally when the root execution completes (queue values at close drain first; later sends stay in the channel). Root completion also flips `ChannelHandle.closed` and makes post-run `handle.send` throw `channel_closed`; a sequential re-run or checkpoint-restore on the same root context reopens its id. The iterable owns a single iterator — subscribe again for a second consumer.

### @noetic-tools/chat-sdk (chat platform integration)

Binds a harness to chat-sdk.dev (npm `chat`, optional peer) as a multi-platform bot brain. Depends only on `@noetic-tools/types`.

```typescript
import { noeticAgent, chatTools, createChatHistoryStore,
         approvalRequests, resolveApproval } from '@noetic-tools/chat-sdk';

chat.onSubscribedMessage(noeticAgent({
  harness,            // any AgentHarness (structural ChatHarness subset)
  historyLimit: 20,   // platform messages seeded on first contact; 0 disables
  history?,           // createChatHistoryStore({get, set}) — durable seeding + item persistence
  deliveryMode?, threadId?, seed?, taskTitle?, onError?,
}));
```

`toItems(messages)` maps platform messages to items (bot's own → assistant `MessageItem` with attachments kept as markdown links, others → user `InputMessageItem` with `userName:` attribution + attachment parts). `streamToChatChunks(events, {messageId})` translates `getFullStream` into Chat SDK chunks (text deltas, `task_update` tool cards flushed at turn end, generic abort notice) — it claims coalesced turns by first-messageId and terminates at the turn boundary; `noeticAgent` attaches the stream BEFORE `execute()` because the broadcaster discards events with no live consumer. `chatTools({chat, requireApproval?})` wraps Chat SDK's AI tools via `fromAiSdkTool`, inheriting the vendor's write-tool gating by default — gated tools send routed requests (`threadId` included) on `approvalRequests`; observe with ONE subscriber per harness via `harness.getChannelStream(approvalRequests, APPROVAL_SCOPE)` and answer with `resolveApproval({harness, decision: {requestId, approved, reason?}})` (returns `false` on stale clicks, never throws). Spec: `specs/29-chat-platform-integration.md`.

## Termination Predicates

```typescript
until.maxSteps(n)              // Stop after n iterations
until.maxCost(n)               // Stop when cumulative cost exceeds n
until.maxDuration(duration)    // Stop after duration milliseconds
until.noToolCalls()            // Stop when LLM doesn't call any tools
until.verified(fn)             // Stop when verification passes
until.never()                  // Never stop (for `schedule` / forever-loops with external abort)
until.converged(opts)          // Stop when output stabilizes
until.outputContains(marker)   // Stop when last output text contains `marker` (substring)
until.outputEquals(sentinel)   // Stop when last output text === `sentinel` (exact match)

// Combinators
any(...predicates)       // Stop when ANY predicate fires
all(...predicates)       // Stop when ALL predicates fire
```

## Patterns

Recurring agent shapes are compositions of the primitives, not separate APIs. Two canonical recipes:

```typescript
// ReAct: LLM with tools, repeat until no tool calls.
const react = loop({
  id: 'react',
  steps: [callModel({ id: 'work', model, instructions, tools })],
  until: any(until.noToolCalls(), until.maxSteps(25)),
});

// Ralph Wiggum: outer verify-and-retry loop; each attempt spawns a fresh context.
const ralph = loop({
  id: 'verify-retry',
  steps: [spawn({ id: 'attempt', child: react })],
  until: any(
    until.verified(async (output) => ({ pass: await checksPass(output) })),
    until.maxSteps(50),
  ),
});
```

### interview

Host-callback-driven structured interview. The model emits a `z.discriminatedUnion('type', [questionEnv, completeEnv])` envelope each turn; the host renders questions via `askQuestion` and answers thread back as the next user message. Terminates on `complete` or `maxQuestions`.

```typescript
interview<Q, C>({
  systemPrompt: string;
  model: string;
  questionSchema: ZodType<Q>;
  completeSchema: ZodType<C>;
  askQuestion: (envelope: Q) => Promise<InterviewQuestionAnswer>;
  onComplete: (envelope: C) => Promise<void>;
  maxQuestions?: number;          // default 8
  formatAnswer?: (a: InterviewQuestionAnswer) => string;
}): Step<ContextData, string, InterviewResult<Q, C>>

type InterviewResult<Q, C> =
  | { status: 'complete'; envelope: C }
  | { status: 'maxQuestions'; lastQuestion?: Q };

interface InterviewQuestionAnswer {
  questionId: string;
  question: string;
  answer: string | string[];
  notes?: string;
}
```

`onComplete` fires once when the model emits the completion envelope. The returned step's output mirrors the final state for callers that prefer return-value style over the callback.

### Dynamic multi-agent task trees

There is no plan-compiler builder. A task tree is either hand-composed from the
control-flow primitives, or expressed as a JSON `WorkflowDocument` and hydrated
by the JSON workflow runtime.

**Hand-composed:** nest `loop`, `inParallel`, `conditional`, and `spawn` — one
`spawn` per sub-agent so each child gets a fresh context, `inParallel` for
sibling fan-out, and a `loop` + `until` predicate around anything that needs
retries. See `references/composition-patterns.md` for worked trees.

**Document-driven:** build (or have the model emit) a `WorkflowDocument` and run
it with `parseAndRunWorkflow`; `dynamicWorkflow` wraps the same thing as a step,
and `hydrateWorkflow(doc, hydrationCtx)` turns a document into a `Step` you can
nest like any other (its `HydrationContext` needs at least `tools` and
`executeStep`). The `plan()` context layer stores exactly this shape —
`PlanState.planTree` is a `WorkflowDocument` and `PlanState.workflows` maps onto
the runtime's named-workflow registry — so an approved plan executes directly:

```typescript
const output = await parseAndRunWorkflow({
  json: planState.planTree,
  harness,
  ctx,
  tools,
  workflows: new Map(Object.entries(planState.workflows)),
});
```

The harness supplies `executeStep` internally (`harness.run`), so nested
`inParallel` inside a sequential chain needs no extra wiring.

## Context Layers

### ContextLayer config fields

Beyond `id`, `slot`, `scope`, `budget`, `hooks`, `provides`, `timeouts`, and `rerenderTiming`, a layer accepts:

```typescript
interface ContextLayer<TState> {
  // ...
  /** What to do when init() throws. Default 'throw' (fail-loud: surface + abort). */
  onInitError?: 'throw' | 'disable';
  /** Whether recall() blocks the model call. Default 'atomic'. */
  recallMode?: 'atomic' | 'eventual';
  /** Which band of the view recall() output lands in. Default 'auto'. */
  placement?: 'anchor' | 'live' | 'auto';
}
```

- **`onInitError`** — `'throw'` (default) surfaces the init error and aborts the execution; layer state is load-bearing and silently disabling it hides failures (and for steering would fail *open*). `'disable'` logs a diagnostic and runs without the layer (its other hooks are skipped). Opt in only for non-critical layers.
- **`recallMode`** — `'atomic'` (default) runs `recall()` synchronously before the model call. `'eventual'` serves `recall()` from a per-harness cache that never blocks; the cache refreshes after the layer's `store()` produces new state, so the next turn sees it. Use `'eventual'` for slow recall paths that can tolerate one-turn staleness.
- **`placement`** — which band of the assembled view this layer's `recall()` output lands in, and so whether it is pinned for the prompt cache. `'anchor'` sits before history and is pinned; `'live'` sits after history and re-renders every turn; `'auto'` (default) lets the runtime pick from observed churn. See [Prompt-cache anchoring](#prompt-cache-anchoring-placement).

### Projection & recall budget

The recall token budget and the assembled context window are governed by a `ProjectionPolicy`, resolved per `callModel` step as `step.projection` → `harness.projection` (`AgentConfig.projection`) → `DEFAULT_PROJECTION`.

```typescript
interface ProjectionPolicy {
  tokenBudget: number;
  responseReserve: number;
  overflow: 'truncate' | 'summarize' | 'sliding_window';
  overflowModel?: string;
  windowSize?: number;
}

// Fallback when neither step nor harness configures one:
const DEFAULT_PROJECTION = { tokenBudget: 128_000, responseReserve: 4_000, overflow: 'sliding_window' };
```

```typescript
interface AgentConfig {
  // ...
  projection?: ProjectionPolicy;   // default for all callModel steps
  forceAtomicRecall?: boolean;     // recall every layer atomically, bypass the eventual cache
  contextCache?: ContextCacheConfig; // prompt-cache anchoring; on by default
}

interface StepCallModel {
  // ...
  projection?: ProjectionPolicy;   // overrides the harness default for this step
}
```

- A single allocator (`allocateBudgets`) splits the recall budget: each layer's `budget.min` is satisfied first, then ~60% of the remainder funds a proportional pool across layers (by headroom `max − min`; `'auto'` and **omitted** budgets have infinite headroom and split the pool after finite layers take their share — the pool is fully conserved) and ~40% is reserved for conversation history. A layer never exceeds its `max`. NaN inputs throw `NoeticConfigError` (`INVALID_BUDGET_INPUT`); `Infinity` = uncapped.
- `assembleView` then holds the final view to a hard cap (`tokenBudget − responseReserve`) and lays it out in bands:

  ```
  system | anchor layers | history | live layers | supersedes | tail
  ```

  Both layer bands arrive slot-ascending. The budget is claimed in this order: system items (never dropped), anchor output, live output, the tail, then the supersedes — with history taking whatever is left and keeping the most recent turns. Within a layer band each non-fitting item is dropped **individually** (later-slot items that still fit are kept); history is trimmed as a contiguous recent window and orphan tool calls are stripped at the boundary. Supersedes are never dropped — each corrects a pinned block already in the view, so dropping one would leave the model reading content known to be stale. History absorbs the cost instead.
- `forceAtomicRecall: true` makes every layer atomic regardless of `recallMode`.

### Prompt-cache anchoring (`placement`)

A prompt cache matches on a prefix, so the first changed token invalidates everything after it. Putting volatile layer output ahead of a large stable history re-bills the whole window every turn. The bands fix that: stable output sits in the **anchor** band ahead of history where the cache can hold it, volatile output sits in the **live** band after history where re-rendering costs almost nothing.

**A stable prefix is not enough on its own — Anthropic caching is opt-in.** Without a `cache_control` breakpoint on the request, Claude models cache nothing however byte-identical the prefix is; OpenAI and Gemini cache on their own and ignore the directive. Measured against a fixed 18,925-token prefix through this code path: Haiku 4.5 and Sonnet 4.5 both reported 0 cached tokens every turn with bands alone, and 18,922 from turn 2 once the breakpoint was added; `gpt-4o-mini` was unchanged at 17,024 of 17,126. So the banding delivered nothing on Claude until the runtime started asking for the cache. It now sends `cache_control: { type: 'ephemeral' }` on every model request while anchoring is on, and OpenRouter places the breakpoints. `contextCache: { enabled: false }` turns off the banding **and** the breakpoint — a cache write costs more than a read, so asking for one only pays off when something is deliberately holding the prefix still. Adapter note: the SDK validates the outbound request against a generated schema that drops unknown keys, so the directive must be injected where the body is final (Noetic uses a `beforeRequest` hook).

An anchored layer is **pinned** for an *epoch*: the bytes sent on the first assembly are replayed unchanged on every later one. When its fresh `recall()` output stops matching the pin, the prefix is left alone and the change is published at the end of the view as one `<context_updates>` developer message — a supersede per stale layer, marked `replace`, `add`, or `retract`, telling the model these override the earlier block with the same layer id.

The epoch only restarts when the cache is already dead. `ReanchorReason` is the exhaustive list: `'cold-start'`, `'instructions-changed'`, `'cache-miss'` (the model's own token report showed the prefix was not read), `'delta-pressure'` (supersedes outgrew the band they patch), `'delta-overflow'` (supersedes no longer fit the window), `'max-age'`. Re-anchoring is the only point at which an `'auto'` layer changes band, so the prefix cannot shift under the model mid-run.

**Choosing a placement:**

| Layer looks like | Use |
|------------------|-----|
| Large, changes rarely, or never after init — loaded instructions, file contents, a skills catalogue | `'anchor'` |
| Changes every turn by construction — a clock, a turn counter, drained feedback, anything appended each round | `'live'` |
| Genuinely unsure | `'auto'` (default) |

`'auto'` starts anchored and moves on watched churn — the share of assemblies in which the layer's output changed. Above `autoDemoteChurn` (0.5) it goes live; at or below `autoPromoteChurn` (0.2) it comes back. The gap between the two is hysteresis, so a layer hovering near the boundary does not flip every epoch. Churn carries across epochs, halved each time, so a band is not relearnt from nothing. An explicit `'anchor'` or `'live'` is never overridden.

**A layer whose `recall()` returns state is never pinned.** Returning `state` marks the call non-idempotent — it committed something — so replaying an older render would throw that commit away. The runtime forces such a layer live whatever its `placement` says. If your `recall()` drains a queue, advances a cursor, or otherwise mutates, declare `'live'` and stop thinking about it.

**Config** (`AgentConfig.contextCache`, all optional):

```typescript
interface ContextCacheConfig {
  enabled?: boolean;             // default true; false restores the old single-block layout AND
                                 //   stops the cache_control breakpoint being sent
  minCachedTokens?: number;      // 100  — cached tokens below this on the first round reads as a miss
                                 //        (held to half the prefix when the prefix is smaller)
  minEpochAssemblies?: number;   // 2    — assemblies before cache figures are judged (the first writes the cache)
  maxEpochAssemblies?: number;   // 50   — re-anchor by age regardless
  deltaBudgetFraction?: number;  // 0.15 — supersedes past this share of the anchor band are pressure,
                                 //        subject to a 256-token floor so the wrapper alone never triggers it
  autoDemoteChurn?: number;      // 0.5  — 'auto' churn at or above this goes live
  autoPromoteChurn?: number;     // 0.2  — 'auto' churn at or below this returns to anchor
  minChurnSamples?: number;      // 3    — assemblies watched before a band moves
  churnDecay?: number;           // 0.5  — share of churn counters carried across a re-anchor
}
```

Defaults are tuned to give an unconfigured layer set a stable prefix, so most agents never set this. A provider that reports no cache figures, or misses persistently, is marked cache-blind and stops being consulted; age and delta pressure still bound the epoch.

**`renderDelta` hook** — optional, for anchored layers whose output is large and whose changes are small:

```typescript
interface RenderDeltaParams<TState> {
  prev: ReadonlyArray<Item>;   // items still pinned — what the model currently sees
  next: ReadonlyArray<Item>;   // the fresh render that would have replaced them
  prevState: TState | undefined; // state as of pinning (by reference — in-place mutation shows through)
  state: TState | undefined;     // current state
  ctx: ExecutionContext;
  budget: number;              // soft token budget for the returned text
}

renderDelta?(params: RenderDeltaParams<TState>): Promise<string | null>;
```

Return a compact description of the change, or `null` to fall back to republishing the full new content. Never called for `'live'` layers. A hook that throws or exceeds the layer's `recall` timeout (default 5s) falls back to the default — a supersede is a correctness obligation and is never skipped because a hook misbehaved. Worth implementing only when a republish would be expensive: `filesystem` implements it to send just the files that changed plus a "no longer referenced" line.

### scratchpad

Thread/resource-scoped structured state, updated via the `scratchpad/update` tool. Updates **deep-merge** into state: nested object keys merge recursively while arrays and primitives replace; `__proto__`/`constructor` are stripped at every depth. An object update applied over prior freeform-string state preserves the old string under a `_previous` key. With a `schema`, the **merged** state is validated on update — a violating update throws (the model sees the error), and corrupt persisted state falls back to `{}` at init.

```typescript
scratchpad({ scope?, schema?, template?, readOnly? })
```

### observations

Accumulates text, distills to observations when buffer exceeds threshold. Buffers the full conversation: assistant output via `store`, plus user input and tool output via `onItemAppend`. `recall` trims output to the allocated budget.

```typescript
observations({ bufferThreshold?, maxObservations?, scope?, observer? })
```

### temporal

LLM-backed long-term memory for time-anchored recall. Distills the conversation into a key-value ledger of timestamped facts (`Record<isoTs, string[]>`) and answers temporal queries on demand. `recall` injects a `<current_datetime>` block (default on) so the model can resolve relative dates and compute differences. The `temporal/searchMemory` tool (auto-injected from `provides`) takes `{ query }` and returns `{ facts, date?, fuzzy? }`.

```typescript
temporal({
  now?, scope?,            // clock injection; 'thread' | 'resource' (default 'resource')
  extract?, search?,       // FactExtractor / FactSearcher — host-injected LLM callbacks
  bufferThreshold?,        // tokens before extract runs, default 2000
  maxFacts?,               // ledger cap, default 200 (per-fact: keeps newest maxFacts)
  groundDateTime?,         // <current_datetime> on recall, default true
  injectLedger?,           // <remembered_facts> on recall, default false
})
// placement: 'live' while groundDateTime is on (the <current_datetime> block changes
// every turn by construction); 'auto' with grounding off, leaving the slow-moving
// fact ledger free to be anchored.
// id 'temporal', slot Slot.REMINDER (80). LLM-agnostic: omit extract/search and the
// layer only buffers / the tool returns the raw ledger (never fabricates facts).
// Buffers assistant output (store) + user/tool input (onItemAppend) for extraction.
// The code agent wires callModel-backed callbacks and installs it by default.
```

### taskState

Persists file lists and checkpoints across executions/iterations within a thread (scope `'thread'`, not `'execution'` — an execution-scoped key would rotate each run and defeat durable rehydration). Checkpoints are capped at the newest 50; `recall` trims its `<task_state>` render to the allocated budget (oldest checkpoints dropped first).

```typescript
taskState({ mergeData? })  // 'shallow' (default) | 'namespace'
// id 'task-state', slot 110, scope 'thread', budget { min: 100, max: 800 }
```

Writable by the model via `provides` → tools `task-state/recordArtifact` (`{ path }` → appends to `files`, idempotent) and `task-state/setTaskData` (`{ key, value }` → sets `data[key]`; refuses the reserved `__outcome`). Recorded artifacts cross child boundaries: `onReturn` unions `files` and merges `data`.

`mergeData` picks the `data` merge at a spawn/inParallel return: `'shallow'` is `{ ...parent, ...child }` (concurrent workers writing the same key clobber each other), `'namespace'` stores the child's map under `childCtx.executionId` — use it for coordinator/worker fan-out.

### filesystem

Tracks `#path/to/file` references in user messages: transforms them to anchor links, reads + LLM-scores each referenced file, and injects contents on recall (priority-ordered, budget-trimmed). New references are read and scored **in parallel**; the layer sets `timeouts: { onItemAppend: 30_000 }` since its append hook does fs + LLM work. Path security: lexical containment in `baseDir` plus a per-component symlink walk (any symlinked path component below `baseDir` is rejected unless `followSymlinks: true`).

```typescript
filesystem({ baseDir?, slot?, scoringModel?, maxFileSize?, followSymlinks?, allowedExtensions? })
// id 'filesystem', slot Slot.RAG (350), scope 'thread', budget 'auto'
// placement: 'anchor' — a large payload that changes a file at a time. Implements
// renderDelta: a supersede carries only the changed file blocks plus a
// "No longer referenced: ..." line, instead of republishing the whole set.
```

### instructions

Loads content at init, injects as tagged XML block in every recall. When over budget, the recalled block is trimmed with the closing tag preserved (well-formed XML); a zero budget is fail-open (full content).

```typescript
instructions({ load: () => Promise<string>, tag?, id?, slot?, scope? })
// placement: 'anchor' — loaded once in init and never rewritten, so it is pinned
// outright rather than waiting for churn telemetry to reach the same verdict.
```

### history

Caps the trailing items projected to the LLM each turn. Storage (`itemLog`, session JSON) is untouched — the cap is a read-side projection via the `projectHistory` hook. Defaults to `maxItems: 40`. Includes a minimum-exchange guarantee (always preserves at least one user + one assistant message), but that expansion is bounded to `maxItems × 4` so a tool-only burst can't grow the window unbounded. Re-attaches a head `system`/anchor message that fell outside the window, and strips orphan `function_call` / `function_call_output` at the slice boundary.

```typescript
history({ maxItems?: number })  // default 40
```

### CLI enhanced-prompt layers (external)

The five layers below (`promptEngineeringLayer`, `communicationStyleLayer`,
`environmentContextLayer`, `toolGuidanceLayer`, `planningModeLayer`) ship with the
Noetic CLI, which is developed in a separate repository
(`github.com/mattapperson/noetic-internal`). They are **not** part of this workspace —
there is no `packages/cli` here, so import them from the published
`@noetic-tools/cli` barrel and never from a `src/` subpath. They are documented here
because they are useful reference designs for layers of your own.

### promptEngineeringLayer

Core behavioral guidelines with tool usage tracking and error-based adaptation. Part of the CLI enhanced-prompt set (external — see the note above).

```typescript
function promptEngineeringLayer(): ContextLayer<PromptEngineeringState>
```

| Property | Value |
|----------|-------|
| **id** | `prompt-engineering` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 200, max: 1000 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Recall injects communication efficiency rules, tool-usage reminders based on frequency, and error-recovery guidance when recent errors exist. Store tracks tool call frequencies and detects error signatures in tool results. Spawn clones patterns and clears error history.

### communicationStyleLayer

Adaptive communication patterns (concise/normal/verbose) based on user message analysis. Part of the CLI enhanced-prompt set (external — see the note above).

```typescript
function communicationStyleLayer(): ContextLayer<CommunicationStyleState>
```

| Property | Value |
|----------|-------|
| **id** | `communication-style` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 150, max: 500 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Recall renders style-specific communication guidelines. Store analyzes user messages for question markers, technical keywords, and preference indicators, then adapts the style accordingly. Spawn clones style and preferences, resets metrics.

### environmentContextLayer

Dynamic environment detection providing platform, git, Node.js, shell, and package-manager context. Part of the CLI enhanced-prompt set (external — see the note above).

```typescript
interface EnvironmentContextConfig {
  config: AgentConfig;
  shell: ShellAdapter;
}

function environmentContextLayer(config: EnvironmentContextConfig): ContextLayer<EnvironmentContextState>
```

| Property | Value |
|----------|-------|
| **id** | `environment-context` |
| **slot** | `Slot.OBSERVATIONS` (200) |
| **scope** | `execution` |
| **budget** | `{ min: 200, max: 800 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Init probes the environment via the shell adapter (git, node, shell type, package manager, available commands) in parallel with individual timeouts. Recall formats into a structured context block. Store is pass-through (environment treated as static). Spawn clones context with updated timestamp.

### toolGuidanceLayer

Context-aware tool usage instructions with preference hierarchy and mode awareness. Part of the CLI enhanced-prompt set (external — see the note above).

```typescript
interface ToolGuidanceConfig {
  tools: ReadonlyArray<Tool>;
  mode?: 'normal' | 'planning';
}

function toolGuidanceLayer(config: ToolGuidanceConfig): ContextLayer<ToolGuidanceState>
```

| Property | Value |
|----------|-------|
| **id** | `tool-guidance` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 300, max: 1200 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Recall emits a tool preference hierarchy (e.g. "Use Read tool, NOT cat/head/tail"), file operation guidelines, and mode-specific guidance. In planning mode, includes plan tool restrictions. If agent delegation tools are available, adds delegation guidelines. Spawn clones tool set and mode, resets failure history.

### planningModeLayer

Specialized guidance for plan-mode operations with workflow-document authoring and phase tracking. Part of the CLI enhanced-prompt set (external — see the note above).

```typescript
interface PlanningModeConfig {
  availableTools: ReadonlyArray<Tool>;
  currentMode: 'normal' | 'planning';
}

function planningModeLayer(config: PlanningModeConfig): ContextLayer<PlanningModeState>
```

| Property | Value |
|----------|-------|
| **id** | `planning-mode` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 400, max: 1500 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Recall returns null when not active. When active, injects workflow-document node guidelines, PRD authoring best practices with a plan.md template, plan-mode tool restrictions, phase-specific objectives (exploration/authoring/review), and exploration progress. Store counts Read calls to auto-transition phases. Spawn clones state, resets progress.

### skillsLayer

Progressive skill disclosure — the model sees a name + description per skill and pulls
full instructions on demand. Not a published built-in: the reference implementation is
`packages/core/examples/deep-agent/context/skills-layer.ts`, which you copy and adapt.

```typescript
interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
}

interface SkillsLayerState {
  definitions: SkillDefinition[];
  activatedSkills: string[];
}

function skillsLayer(skills: SkillDefinition[]): ContextLayer<SkillsLayerState>
```

| Property | Value |
|----------|-------|
| **id** | `skills-context` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 300, max: 2000 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Recall emits an `<available_skills>` block (one `name` + `description` per skill), appends the full `### Instructions` body of every activated skill, and closes with a line telling the model to call `activateSkill({ name })`. Store uses `findFunctionCall(newItems, 'activateSkill')` and appends the named skill to `state.activatedSkills` (ignoring unknown names and repeats). Spawn deep-clones parent state to the child.

The Noetic CLI ships an extended variant of this layer (a `cwd` config, inline shell-command expansion inside skill bodies, and an LRU result cache), but it is developed in a separate repository and is not importable from this workspace.

### toolCalls

Generates layers from `ToolContextDeclaration` on tools. Tools sharing the same `context.id` share state. Defaults to `'execution'` scope.

```typescript
toolCalls(tools: Tool[], opts?: { slot? })
```

### CLI task-system layers (external)

The three layers below (`createSteeringFileLayer`, `createFixFeedbackLayer`,
`createPlannerAttemptLayer`) are internal to the Noetic CLI's task system, which lives in
a separate repository (`github.com/mattapperson/noetic-internal`). They are not exported
from this workspace and not importable from the `@noetic-tools/cli` barrel — treat them
as worked examples of scoping and slot choice. The contract they implement is specified
in `specs/21-tasks.md`.

### createSteeringFileLayer (CLI-internal)

Surfaces a per-task `steering.md` file to the agent run servicing that task. The harness factory mounts it unconditionally; activation is gated by the `NOETIC_TASK_DIR` env var that the task launcher sets when spawning agent-ci for a specific task. Non-task agent runs see no steering content.

```typescript
const layer = createSteeringFileLayer();
// slot:  Slot.STEERING (90) — ahead of the scratchpad and observations
// scope: 'execution'
// budget: { min: 0, max: 8000 }
```

Behaviour:

- When `process.env.NOETIC_TASK_DIR` is unset or empty, `recall()` returns `null` and the layer is dormant.
- When set, `recall()` reads `<NOETIC_TASK_DIR>/steering.md` via `ctx.fs.readFileText`. ENOENT and empty content both yield `null` (no steering content).
- A non-empty `steering.md` is wrapped in a `# Task Steering` heading and emitted as a developer-role block.

The layer carries no state (`state: null`); everything is resolved at recall time, so a steering file edited mid-session takes effect on the next recall. See `specs/21-tasks.md` for the full task-system contract.

### createFixFeedbackLayer (CLI-internal)

Thread-scoped layer that carries the implementer's retry-feedback bundle (parent-task plan, description, accumulated assertion failures, attempt count) across iterations of the implementer↔validator retry loop.

```typescript
const layer = createFixFeedbackLayer({
  initial: { plan, description, accumulatedIssues, attempt: 1 },
});
// slot:  Slot.SCRATCHPAD (100)
// scope: 'thread'
// recall(): emits a developer-role "# Implementation context" block when state is non-empty.
// provides.update: layerFunction that merges new feedback (plan/description/issues/attempt).
// onSpawn: clones parent state to the child so a sub-flow inherits the bundle.
```

The implementer-runner seeds this layer's `initial` from disk (parent task description + accumulated `assertionOutcomes` from prior validator runs in the feature's fix lineage), so each retry's react loop sees prior failures via `recall()` without depending on chat-history continuation.

### createPlannerAttemptLayer (CLI-internal)

Resource-scoped layer that tracks per-task planner-attempt counts and persists them to `<projectRoot>/.noetic/tasks/_planner-attempts.json`. The autopilot's plan-pass reads the file directly to gate retry budget; the planner subprocess increments via `recordAttempt`.

```typescript
const layer = createPlannerAttemptLayer({ projectRoot, maxAttempts? });
// slot:  Slot.REMINDER (80) — code-only, no recall surface
// scope: 'resource'
// provides.snapshot: layerData → { attempts, maxAttempts }
// provides.recordAttempt: layerFunction → increment + persist
// provides.clearAttempts: layerFunction → drop a task's counter
```

`MAX_PLANNER_ATTEMPTS` (default 3) caps re-spawns per task so a permanently-failing planner can't burn unbounded LLM tokens on the autopilot's 60-second tick.

### ToolContextDeclaration

Declared on a `Tool`'s `context` property. The runtime auto-generates a `ContextLayer` per unique `id`.

```typescript
interface ToolContextDeclaration<TState = unknown> {
  id?: string;                              // shared id (defaults to tool.name)
  init: () => TState;                       // factory for initial state
  recall: (state: TState) => string | null; // project into LLM context
}
```

Tools read/write state imperatively via `toolCtx.context`:

```typescript
interface ToolContext {
  get<T>(layerId: string): T | undefined;
  set<T>(layerId: string, state: T): void;
}
```

### findFunctionCall

Utility for function-call layer-state patterns. Searches items for the first `function_call` matching a name, returns parsed JSON arguments.

```typescript
import { findFunctionCall } from '@noetic-tools/core';

const args = findFunctionCall(newItems, 'saveNote');
// Returns Record<string, unknown> | null
```

Used in `store()` hooks to let the LLM update layer state via pseudo-tool calls (no registered tool schema required).

### steering

Intercepts tool calls and model responses via programmatic or LLM-evaluated rules. Maintains an activity ledger. Slot 90 (runs before all other layers). `placement: 'live'` — `recall` drains the pending feedback queue as it renders, so its output can never be replayed from a pin, and rendering after history is where the model weighs guidance most.

```typescript
steering({
  rules: SteeringRule[];
  maxLedgerEntries?: number;  // default 100
  maxRetries?: number;        // default 1 (retries on unparseable verdict)
  scope?: ContextScope;        // default 'execution'
}): ContextLayer<SteeringState>
// LLM-evaluated rules use callModel from the execution context (configured
// via AgentHarness's `llm` option or OPENROUTER_API_KEY). If no LLM provider
// is configured, LLM-evaluated rules throw NoeticConfigError (MISSING_CALL_MODEL).
// The model is asked to reply ALLOW / DENY / "GUIDE: <text>"; the verdict keyword
// is matched at the start on a word boundary, case-insensitively, with guidance
// text preserved verbatim. Unparseable replies retry up to maxRetries, then pass.
```

**SteeringRule:**
```typescript
interface SteeringRule {
  id: string;
  name?: string;
  appliesTo: ('beforeToolCall' | 'afterModelCall')[];
  predicate?: (params: BeforeToolCallParams | AfterModelCallParams) => SteeringDecision;
  llmEval?: { mode: 'sync' | 'async'; prompt: string; model?: string };
}
```

**SteeringAction:** `Allow`, `Deny`, `Guide` — `Deny` short-circuits, `Guide` injects feedback.

**Lifecycle hooks:** `beforeToolCall` (intercept tools), `afterModelCall` (validate responses), `recall` (inject async feedback), `onSpawn` (clone ledger).

### plan

Manages PRD authoring and plan execution lifecycle. Enters a restricted "plan mode" where only read-only tools are allowed, the LLM writes a PRD and structures the plan as a JSON `WorkflowDocument` (spec 26) plus named sub-workflows, then exits to execution.

```typescript
plan({
  scope?: ContextScope;                    // default 'thread'
  additionalAllowedTools?: string[];      // extra tools allowed in plan mode
  maxPrdLength?: number;                  // default 50_000
  maxDepth?: number;                      // workflowDepth cap for tree + workflows; default 5
  maxWorkflows?: number;                  // named workflow count cap; default 20
  maxWorkflowChars?: number;              // per-workflow serialized size cap; default 20_000
  allowedNodeKinds?: WorkflowNode['kind'][]; // optional profile; must include 'subflow' if set
  style?: PlanStyle;                      // 'phased' (default) | 'interview'
  subAgentTool?: string;                  // host's sub-agent tool name; gates sub-agent guidance
  additionalPlanInstructions?: string;
  onEnterSession?: () => Promise<{ slug: string }>;
  onExit?: (state: PlanState) => Promise<{ approved: boolean }>;
}): ContextLayer<PlanState>
```

**State:** `{ phase, prd, planTree: WorkflowDocument | null, workflows: Record<string, WorkflowDocument>, executionLog, version, planSlug? }`. Phase transitions: `idle → planning → executing → completed/failed`.

**Provides (auto-exposed as LLM tools):**
- `plan/enterPlanMode({ goal? })` — transitions idle → planning, optionally seeds PRD; resets workflows
- `plan/updatePrd({ content })` — replaces PRD content (planning phase only)
- `plan/setPlanTree({ document })` — sets the plan as a `WorkflowDocument` (schema/depth/kind/ref-slug validated in-execute; JSON strings accepted); refs to not-yet-defined workflows are listed in the result
- `plan/setWorkflow({ name, document })` — upserts a named workflow (slug names, count/size/depth caps)
- `plan/removeWorkflow({ name })` — deletes; warns when still referenced
- `plan/getWorkflow({ name })` — returns the stored JSON (recall shows summaries, not bodies)
- `plan/exitPlanMode({ action: 'execute' | 'cancel' })` — `execute` rejects dangling subflow refs and workflow cycles before invoking `onExit`
- `status` (layerData) — `{ phase, hasPrd, hasPlanTree, workflowNames, version }`

**Planning styles (`style`):** `PlanStyle.Phased` (default) runs understand → design → review → write → exit. `PlanStyle.Interview` loops explore → write → ask, growing the PRD from a skeleton — better when requirements are still vague. Both end a turn only with `AskUserQuestion` or `plan/exitPlanMode`; asking for approval in prose is ruled out explicitly.

**Sub-agents (`subAgentTool`):** the layer ships no sub-agent tool, so the briefing carries no sub-agent guidance until a host names one. Set it to enable the parallel-exploration advice (how many explorers, when a second perspective pays, what background to hand each agent).

**Briefing is rendered from config:** the tool list is the layer's allow-set (so `additionalAllowedTools` shows up), the node-kind guidance is filtered by `allowedNodeKinds`, and `setPlanTree`'s description is built from the same kind table — briefing and tool cannot disagree.

**Recall budget:** briefing and state share `{ min: 100, max: 3000 }` tokens. State gives way first and is *trimmed to the headroom*, not dropped whole. Rules are never cut mid-sentence — a compact briefing replaces them, and below that `recall` returns `null`.

**Executing an approved plan:** feed `state.planTree` + `new Map(Object.entries(state.workflows))` to `parseAndRunWorkflow({ json, workflows, ... })` — the plan format IS the JSON workflow runtime format.

**Lifecycle hooks:** `init` (load from storage; legacy trees reset to null), `recall` (phase-dependent context injection), `beforeToolCall` (restrict to read-only in planning), `onSpawn` (clone state), `onComplete` (record outcome).

## Layer Provides API

Layers expose typed data and functions via the `provides` field. Data becomes direct properties and functions become async methods on `ctx.context['layerId']`. Functions are also automatically injected as LLM tools (namespaced `layerId/fnName`).

### context()

Wraps a layer tuple for type-safe inference. Uses `const` type parameter to preserve literal types without `as const`.

```typescript
context<const T extends readonly ContextLayer[]>(layers: T): ContextConfig<T>
```

### InferContext\<T\>

Extracts the typed context shape from a `ContextConfig` (like `z.infer<>` for Zod).

```typescript
const layers = context([scratchpad(), counterLayer()]);
type Ctx = InferContext<typeof layers>;
// Use as: runCode<Ctx>({ execute: (input, ctx) => { ctx.context.counter.value } })
```

### ContextConfig

Typed wrapper preserving individual layer types for compile-time inference.

```typescript
interface ContextConfig<TLayers extends readonly ContextLayer[] = readonly ContextLayer[]> {
  readonly layers: TLayers;
  readonly _shape: InferContextShape<TLayers>;  // phantom — never accessed at runtime
}
```

### layerData

Creates a read-only data projection from layer state.

```typescript
layerData<T, TState>({
  read: (state: TState) => T;
}): LayerDataDecl<T, TState>
```

### layerFunction

Creates a callable function backed by layer state. Input is Zod-validated at runtime.

```typescript
layerFunction<TInput, TOutput, TState>({
  description: string;
  input: ZodType<TInput>;
  output: ZodType<TOutput>;
  execute: (args: TInput, state: TState, ctx: ExecutionContext)
    => Promise<{ result: TOutput; state?: TState }>;
}): LayerFunctionDecl<TInput, TOutput, TState>
```

### ctx.context

Layer provides keyed by layer ID. Data entries are live property reads; function entries are async callable methods.

```typescript
const layers = context([scratchpad()]);
type Ctx = InferContext<typeof layers>;

runCode<Ctx>({
  id: 'work',
  execute: async (input, ctx) => {
    ctx.context['scratchpad'].snapshot;        // ScratchpadState (live read)
    await ctx.context['scratchpad'].update({ k: 1 }); // calls layerFunction, updates state
  },
});
```

### Automatic LLM tool injection

Layer functions in `provides` are automatically exposed as tools to any `callModel` running in the same context. Tool names are `layerId/functionName` (e.g. `scratchpad/update`).

## CwdState (shared cwd)

Every `Context` carries a mutable `cwdState: CwdState` that tools resolve relative paths against at execution time. The Bash tool intercepts plain `cd <path>` and mutates the shared state via `setToolCwd`; subsequent Read, Write, Edit, Ls, Grep, Find, lsp, and InteractiveTerminal calls see the new cwd. Spawned and parallel children get a snapshot (POSIX-fork semantics).

```typescript
interface CwdState {
  cwd: string;            // absolute path
  previousCwd?: string;   // populated on cd; powers `cd -`
}

// Read live cwd from a tool's execute function. Pass the factory cwd as a
// fallback for partial test contexts.
function getToolCwd(ctx: Context | undefined, fallback?: string): string;

// Update the shared cwd. Caller must pass an absolute, validated path.
function setToolCwd(ctx: Context, nextCwd: string): { previousCwd: string; newCwd: string };

// Internal: temporarily retarget cwd so an immediately-following spawn
// snapshots the new value. Returns a restore callback. Used by worktree
// isolation in the sync agent-spawn path.
function retargetCwdForSpawn(ctx: Context, nextCwd: string): () => void;
```

`AgentHarness` exposes `rootCwdState` (the shared object seeded into root contexts) and `setRootCwd(nextCwd)` for hosts (e.g. the TUI) to report a user-issued `!cd`.

`AgentHarness` constructor accepts `initialCwd?: string` (default `process.cwd()`), and both `createContext({ cwdInit })` and `detachedSpawn(..., { cwdInit })` accept a per-context override used by worktree isolation.

The mutation policy's `sessionCwd` is anchored to the launch cwd and does NOT follow agent `cd` — `cd` is a UX convenience, not a sandbox-widening mechanism.

## FsAdapter

Filesystem abstraction used by the harness, tools, context layers, and skill discovery. Defaults to `createInMemoryFsAdapter()` from `@noetic-tools/core` — core ships only contracts and in-memory adapters. For real disk access, pass `createLocalFsAdapter()` from `@noetic-tools/platform-node` (Node.js `fs/promises`).

```typescript
interface FsStats {
  size: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

interface FsAdapter {
  readFile(path: string): Promise<Buffer>;
  readFileText(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes(path: string, content: Buffer): Promise<void>;  // binary-safe write
  appendFile(path: string, content: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  access(path: string, mode?: number): Promise<void>;
  stat(path: string): Promise<FsStats>;
  lstat(path: string): Promise<FsStats>;
  readdir(path: string): Promise<string[]>;
}
```

Pass a custom adapter to the harness:

```typescript
import { AgentHarness } from '@noetic-tools/core';
// Node-only adapters live in the platform package, never in core.
import { createLocalFsAdapter } from '@noetic-tools/platform-node';

const harness = new AgentHarness({
  name: 'my-agent',
  params: {},
  environment: {
    fs: createLocalFsAdapter(),  // optional, defaults to createInMemoryFsAdapter()
  },
});
```

Access from tools and layers:

```typescript
// In a tool execute function:
tool({
  name: 'read-config',
  execute: async (args, toolCtx) => {
    const content = await toolCtx.fs.readFileText('/etc/config.json');
    return JSON.parse(content);
  },
});

// In a context layer hook:
hooks: {
  async init({ ctx }) {
    const data = await ctx.fs.readFileText('./state.json');
    return { state: JSON.parse(data) };
  },
}

// From Context in a step:
runCode({
  id: 'load',
  execute: async (input, ctx) => {
    return ctx.fs.readFileText('./data.txt');
  },
});
```

## ShellAdapter

Shell execution abstraction used by the harness, tools, context layers, and skill processing. Defaults to `createInMemoryShellAdapter()` from `@noetic-tools/core` — core ships only contracts and in-memory adapters. To run real commands, pass `createLocalShellAdapter()` from `@noetic-tools/platform-node` (Bun.spawn).

```typescript
interface ShellExecOptions {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  stdin?: string;
  signal?: AbortSignal;
  onData?: (data: Buffer) => void;
}

interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface ShellAdapter {
  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult>;
}

interface CreateLocalShellAdapterOptions {
  /** Wrap commands through `rtk rewrite` for token-efficient output. Default false. */
  useRtk?: boolean;
}

interface LocalShellAdapter extends ShellAdapter {
  readonly rtkAvailable: boolean;
  readonly rtkPath: string | null;
  readonly useRtk: boolean;
}
```

`createLocalShellAdapter(opts?)` (from `@noetic-tools/platform-node`) accepts `{ useRtk }`. When `true`, every command is rewritten through [`rtk rewrite`](https://github.com/rtk-ai/rtk) (a Rust CLI proxy that filters and summarizes output) before exec. Best-effort: any failure falls through to raw `sh -c`. Defaults to `false` so embedders keep raw shell semantics; `@noetic-tools/cli` opts in via its own bootstrap and fails fast when rtk is missing on PATH.

Pass a custom adapter to the harness:

```typescript
import { AgentHarness } from '@noetic-tools/core';
import { createLocalShellAdapter } from '@noetic-tools/platform-node';

const harness = new AgentHarness({
  name: 'my-agent',
  params: {},
  environment: {
    shell: createLocalShellAdapter(),  // optional, defaults to createInMemoryShellAdapter()
  },
});

// Or opt into rtk wrapping explicitly:
const rtkShell = createLocalShellAdapter({ useRtk: true });
if (!rtkShell.rtkAvailable) throw new Error('rtk is required but not on PATH');
```

Access from tools and layers:

```typescript
// In a tool execute function:
tool({
  name: 'run-lint',
  execute: async (args, toolCtx) => {
    const result = await toolCtx.shell.exec('eslint .', { cwd: '/app' });
    return result.stdout;
  },
});

// In a context layer hook:
hooks: {
  async init({ ctx }) {
    const result = await ctx.shell.exec('git rev-parse HEAD', { cwd: '.' });
    return { state: { commitHash: result.stdout.trim() } };
  },
}
```

## AgentHarness

`AgentHarness` is generic over `TParams`. The `config` property exposes `AgentConfig<TParams>`, and steps/tools access params via `ctx.harness.config.params`. Execution surfaces are configured via the `environment` option (`{ storage?: { adapter?, checkpointStore?, layerStateStore?, stepLedgerRetention? }, fs?, shell?, subprocess? }`); every field defaults to an in-memory adapter. The `fs` property exposes the configured `FsAdapter`, and `shell` the configured `ShellAdapter`. Default context layers come in through `contextLayers`, and the default model-provider configuration through `callModelDefaults` (an `LlmProviderConfig`).

### Sessions and the Message Queue

Each `threadId` is a **session**: a long-lived broadcaster + message queue + item log carried across turns. `execute()` enqueues a message on the session identified by `options.threadId` (or a default thread) and returns `Promise<void>` once the message is accepted. Response is observed via session-scoped accessors.

```typescript
const harness = new AgentHarness({
  name: 'my-agent',
  agentGraph: myStep,
  params: { model: 'anthropic/claude-sonnet-4-20250514' },
  defaultDeliveryMode: 'next-turn',
});

// Queue a message and wait for the response.
await harness.execute('Hello');
const response = await harness.getAgentResponse();

// Stream text deltas across every turn in the session.
for await (const delta of harness.getTextStream()) {
  process.stdout.write(delta);
}

// With options (per-thread routing + delivery mode override).
await harness.execute('Hello', {
  threadId: 'thread-1',
  resourceId: 'user-1',
  deliveryMode: 'between-rounds',
});

// Submit while the agent is generating — the message queues.
await harness.execute('follow-up', { threadId: 'thread-1' });

// Cancel the in-flight turn. Queued messages stay and drive the next turn.
await harness.abort({ threadId: 'thread-1', reason: 'user' });

// Preview the items that would be sent on the next turn — accumulated history
// plus harness-level context layer recall outputs. Read-mostly debug helper for
// inspecting "what the model will see"; safe to call between turns.
const items = await harness.previewRequestItems({ threadId: 'thread-1' });
```

### Delivery Modes

| Mode | Behaviour |
|------|-----------|
| `next-turn` (default) | Queue and run after the current turn completes. |
| `between-rounds` | Inject as a user item before the next tool-round LLM call within the active turn. |
| `interrupt` | Abort the in-flight turn, place message at head of queue, restart. |

### Stream Idle Timeout

Every in-flight provider call is guarded by a stream-idle watchdog with a fixed 120-second window. The watchdog re-arms on every SSE event; if the stream goes silent for the full window, the harness emits `{name}:model_call_stalled` and the surrounding turn fails with `turn_aborted { reason: "model stream idle timeout after <N>ms" }`, so a provider that quietly drops the connection surfaces as an error rather than a hang.

### Harness-wide Tools

`AgentHarnessOpts.tools?: Tool[]` seeds a tool pool merged with tools collected from `agentGraph` into every context's `ctx.unifiedTools`. Dedupe is **name-based, first-wins** — the merge order is `[...stepCollectedTools, ...harnessTools]`, so on a name collision the step-collected instance wins. This is the supported way to provide tools when the workflow graph is fully static and `callModel.tools` is a `(ctx) => ctx.unifiedTools.filter(...)` getter — function-form `step.tools` cannot be walked by `collectAllTools`, so the harness option is the only way to make those tools visible to the pool.

```typescript
const harness = new AgentHarness({
  name: 'my-agent',
  agentGraph: myStaticWorkflow,
  tools: [readTool, writeTool, bashTool],
  params: { model: 'anthropic/claude-sonnet-4-20250514' },
});
```

### Session Accessors

| Method | Description |
|--------|-------------|
| `getAgentResponse(scope?)` | Resolves once the session drains its queue. |
| `getItemStream(scope?)` | Cumulative item snapshots across every turn. |
| `getTextStream(scope?)` / `getReasoningStream(scope?)` | Text / reasoning deltas. |
| `getFullStream(scope?)` | Raw SDK + framework events. |
| `abort(scope?)` | Cancel in-flight turn; queued messages preserved. |
| `getStatus(scope?)` | `{ kind: 'idle' \| 'generating' \| 'aborting' }`. |
| `getQueueSize(scope?)` | Count of queued messages. |

Subscribe to streams before the first `execute()` if you want to observe the very first turn — the session broadcaster replays buffered events to late subscribers within its buffer window.

### Low-Level API

```typescript
// Manual context creation + run() (bypasses the session queue)
const ctx = harness.createContext({ threadId: 'thread-1' });
const runResult = await harness.run(step, input, ctx);

// Background execution (inherits parent's threadId by default)
const handle = harness.detachedSpawn(step, input, ctx);
await handle.await();

// Background execution with isolated session log (does NOT pollute parent's
// `session.accumulatedItems` — use for long-running sub-agents)
const isolatedHandle = harness.detachedSpawn(step, input, ctx, {
  threadId: 'background-task-1',
});

// Per-call subprocess adapter override (run a specific spawn out-of-process)
import { createFileStorage, createLocalSubprocessAdapter } from '@noetic-tools/platform-node';
const localAdapter = createLocalSubprocessAdapter({
  storage: createFileStorage({ root: `${process.env.HOME}/.noetic/subprocess` }),
});
const osChildHandle = harness.detachedSpawn(step, input, ctx, {
  subprocess: localAdapter,       // takes precedence over step.subprocess + harness.subprocess
  cwdInit: '/tmp/workspace',
});

// Channels
await harness.send(channel, value, ctx); // back-pressured on full queue channels
const msg = await harness.recv(channel, ctx);
const msg2 = harness.tryRecv(channel, ctx);
```

### Cancellation

| Call | Description |
|------|-------------|
| `ctx.abort(reason?)` | Synchronous, no layer teardown. Cascades **down** the execution tree — every live `inParallel` path and `spawn` child (and their descendants) is aborted too; never up, so aborting one path leaves the parent and siblings running. First call wins, so `ctx.abortReason` is stable. |
| `await harness.cancel(ctx, reason?)` | Same abort, plus context-layer teardown per context — `onComplete` with `outcome: 'aborted'`, then `dispose` — run bottom-up (children before parents). No-op on an already-cancelled context. |
| `await harness.abort(scope?)` | Session-level: cancels the in-flight *turn* for a thread (queued messages preserved), which aborts that turn's context tree. |

Cancellation reaches inside the work in flight: blocked `recv` / parked `send` reject with `cancelled`, the provider stream and tool-round loop stop mid-generation, and an ACP agent (`step.acpAgent`) turn is interrupted via `session/cancel`. Tokens and cost already spent stay charged to the context; the truncated response is not returned — the step throws `cancelled`. Beyond those points it is cooperative: a `runCode` body that ignores `ctx.aborted` between `await`s runs to its next step boundary.

`DetachedHandle` is a thin wrapper over the adapter's `SubprocessHandle`. `.await()` polls `adapter.get()` until the handle reaches a terminal status, then reads the result from `handle.metadata.result` (or rehydrates `handle.metadata.error`). The default adapter (`createInMemorySubprocessAdapter()`) runs the step in-process on the microtask queue, so short-lived detached spawns resolve in sub-millisecond time; out-of-process adapters wait for the OS child to exit.

## Subprocess Adapters and Durable Execution

The harness always holds a `SubprocessAdapter`. Every `runCode`, `spawn`, and `harness.detachedSpawn` dispatches through `harness.subprocess.spawn(...)`. In-process vs out-of-process is a property of the adapter, never of the step. Zero-config harnesses use `createInMemorySubprocessAdapter()`, so dispatch overhead is essentially zero and every pre-existing in-process path keeps its behaviour.

### The adapter interface

```typescript
interface SubprocessAdapter {
  spawn(request: SubprocessRequest): Promise<SubprocessHandle>;
  get(handleId: string): Promise<SubprocessHandle | null>;
  stop(handleId: string, reason?: string): Promise<SubprocessStopResult>;
  pause(handleId: string): Promise<SubprocessControlResult>;
  resume(handleId: string): Promise<SubprocessControlResult>;
  isAlive(handle: SubprocessHandle): Promise<boolean>;
  /** Rebind to a handle persisted across a host restart. Returns null
   *  when no manifest exists for the id. */
  reattach(handleId: string): Promise<SubprocessHandle | null>;
  /** Enumerate every handle the adapter currently treats as live. */
  listLive(): Promise<ReadonlyArray<SubprocessHandle>>;
}
```

`SubprocessRequest` is a discriminated union:

- `ProcessSubprocessRequest` (`kind: 'process'` or omitted) — launch an OS-level child.
- `StepSubprocessRequest` (`kind: 'step'`) — dispatch a registered Noetic step. Carries `stepId`, `serializedInput`, `executionId`, `overrides: { threadId?, resourceId?, cwdInit? }`.

`SubprocessHandle.metadata` carries well-known keys populated by the adapter: `result` (on successful completion), `error` (on failure, as `SerializedError`), and `executionId` (echoed from the request). Callers may attach additional tags via `request.metadata` — the tasks system uses `taskRole`, `taskId`, `featureId` so `findLiveTaskHandle({adapter, taskId, taskRole})` can locate a live handle without scanning sidecar files.

### Factories

```typescript
// From `@noetic-tools/core`: in-process dispatcher (default; also the test double).
function createInMemorySubprocessAdapter(opts?: {
  storage?: StorageAdapter;                                   // persist manifests for listLive/reattach
  metadataInjector?: (request: SubprocessRequest) => Partial<SubprocessHandleMetadata>;
}): SubprocessAdapter;

// From `@noetic-tools/platform-node`: OS-child-process backend. Persists
// full handle manifests (pid,
// pidStarttime, socketPath, cwd, stepId, serializedInput, executionId,
// metadata) through `storage` when given one. Without storage, listLive()
// returns the empty set and reattach() returns null.
function createLocalSubprocessAdapter(opts?: {
  storage?: StorageAdapter;
  signaller?: ProcessSignaller;
}): SubprocessAdapter;
```

`createInMemorySubprocessAdapter({metadataInjector})` is especially handy in tests: each spawn's returned handle has the injected metadata merged onto it synchronously, so unit tests can stamp `{taskRole: 'planner', taskId: 'T-...'}` without mutating the request surface.

### CheckpointStore + CheckpointSnapshot

```typescript
interface CheckpointSnapshot {
  schemaVersion: 2;  // `CheckpointSchemaVersion`; v1 snapshots are rejected with CHECKPOINT_SCHEMA_MISMATCH
  executionId: string;
  threadId?: string;
  resourceId?: string;
  frontier: Array<{ stepId: string; input: unknown; state?: unknown }>;
  layers: Record<string, unknown>;
  cwd: { current: string | null; previous?: string | null } | null;
  askUser: Array<{ id: string; input: unknown; createdAt: number }>;
  itemLog: { items: unknown[] };
  capturedAt: string;
}

interface CheckpointStore {
  save(snapshot: CheckpointSnapshot): Promise<void>;
  load(executionId: string): Promise<CheckpointSnapshot | null>;
  list(): Promise<ReadonlyArray<{ executionId: string }>>;
  clear(executionId: string): Promise<void>;
}

function createCheckpointStore(opts: { storage: StorageAdapter }): CheckpointStore;
```

Pass a checkpoint store to the harness constructor via `environment.storage.checkpointStore` to turn `harness.checkpoint(ctx)` and `harness.restore(executionId)` into real crash-recovery hooks. Snapshots fire automatically after every `execute()`, `detachedSpawn()` settlement, ask-user enqueue, and `runAppendPipeline`. Failures are swallowed with `console.warn` so durability issues never abort a successful step.

#### Restoring a decorated context

```typescript
interface RestoreContextOptions {
  parent?: Context;
  state?: unknown;
  contextLayers?: ContextLayer[];
}

harness.restore(executionId: string, opts?: RestoreContextOptions): Promise<Context | null>;
```

A snapshot recovers data, not the live objects a host attached to the original context (broadcasters, queues, abort registrations). Pass them back through `opts` or the resumed run gets a bare context and the loss is silent. Snapshot-owned fields (`items`, `threadId`, `resourceId`, cwd) are deliberately not accepted — they always come from the persisted record. Decoration applied after construction (`Object.assign`ed fields, abort registration) goes on the returned context, whose `id` is already the original `executionId`.

### Step-level resume and ledger retention

A `checkpointStore` also turns on the **step-completion ledger**: one sharded entry per completed step (`execution:<id>:ledger:<seq>`) carrying that step's output, which a restored context replays instead of re-running. Memoization, not skip — the recorded value is what flows downstream. Failures are never recorded, and a step whose identity changed at a recorded path re-runs and drops its recorded subtree.

```typescript
interface StepLedgerRetention {
  maxEntryBytes?: number; // default 128 * 1024 — larger outputs are NOT recorded
  maxEntries?: number;    // default 1e3 — appending past this evicts the oldest entry
}

const harness = new AgentHarness({
  name: 'durable',
  params: {},
  environment: {
    storage: {
      checkpointStore,
      stepLedgerRetention: { maxEntries: 5e3 },   // Infinity disables a cap
    },
  },
});

// Discards the snapshot AND every ledger shard for one execution.
await harness.clearCheckpoint(executionId);
```

Both caps degrade resume rather than break it: a step with no entry simply re-runs (costing work and re-doing its effects, never replaying a value that disagrees with the recorded run). A non-positive or `NaN` cap throws `NoeticConfigError` with `code: 'STEP_LEDGER_RETENTION_INVALID'` at construction.

Call `clearCheckpoint` when the **workflow changed** — replay happens at the coarsest completed granularity, so a finished parent replays wholesale and an edit to one of its children is never noticed — and when an execution is finished or abandoned, since `checkpointStore.clear()` alone strands the ledger's per-step keys.

The ledger covers control flow and `callModel` steps. It does not make tool execution exactly-once: fence effects at the tool/host boundary.

### `createFileStorage`

```typescript
// from '@noetic-tools/platform-node'
function createFileStorage(opts?: { root?: string }): StorageAdapter;
```

File-backed `StorageAdapter`. Each key becomes a JSON file under `root`; writes use write-temp-then-rename for atomicity on POSIX filesystems. Defaults to `$HOME/.noetic/checkpoints` when `root` is omitted — for subprocess manifests, pass `{root: '$HOME/.noetic/subprocess'}` explicitly to keep manifests and snapshots on distinct disk roots.

### `storageGetMany` and `StorageAdapter.getMany`

```typescript
interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  getMany?<T>(keys: string[]): Promise<Map<string, T>>;   // optional batch read
}

function storageGetMany<T>(
  storage: Pick<StorageAdapter, 'get' | 'getMany'>,
  keys: string[],
): Promise<Map<string, T>>;
```

`list()` returns keys, so reading the values behind a prefix is an N+1 — one round trip per key on a database- or network-backed adapter. `getMany` collapses that into one call; it is optional so pre-existing adapters stay valid.

**Never call `storage.getMany` directly.** Use `storageGetMany(storage, keys)`, which delegates when the backend implements it and sweeps `get` in parallel when it does not. This is what `StepLedgerStore.load()` (restore path) and the semantic-condition embedding cache use.

Implementation contract: missing keys are **absent** from the returned map, never mapped to `null` (a falsy stored value is present); ordering is not guaranteed, so a caller that needs order iterates its own key list and looks values up. `createInMemoryStorage()` (from `@noetic-tools/core`) and `createFileStorage()` (from `@noetic-tools/platform-node`) both implement it.

`ScopedStorage` — what a context layer's `init` hook receives — exposes `getMany` as a **required** method, with scope-relative keys in the result and the fallback supplied by the wrapper.

### Host-restart recovery

Recovery after a host restart is two harness calls — no dedicated API:

```typescript
// Rediscover children the previous process left running.
const handles = await harness.subprocess.listLive();
//   ReadonlyArray<SubprocessHandle>  ({ id, status, startedAt, metadata? })

for (const handle of handles) {
  const executionId = handle.metadata?.executionId;
  if (executionId === undefined) {
    continue;
  }
  // Rebuild that child's context from its checkpoint.
  const ctx = await harness.restore(executionId);
  if (ctx === null) {
    continue; // live handle, but no snapshot on disk
  }
  // ctx carries the pre-crash item log, layer state, and cwd.
}
```

With no durable storage configured `listLive()` returns an empty array and `restore()` returns `null` — a cheap no-op on every startup path. The Noetic CLI wraps exactly this loop in a `reattachLiveChildren(harness)` helper, but that lives in a separate repository; any host can call the two primitives directly.

### Runtime primitives for long-lived runners

`@noetic-tools/core` exports four primitives the tasks-system runners (and third-party long-running agents) use to compose their loop:

```typescript
// Single-shot resolve/reject signal.
interface DetachedSignal<T> {
  done: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}
function createDetachedSignal<T>(): DetachedSignal<T>;

// Generic turn-driver: seed session → first turn → await signal.
function runnableLoop<TOutcome>(opts: RunnableLoopOpts<TOutcome>): Promise<TOutcome>;

// Two-strike nudge composable with runnableLoop.
function createStallNudgeHook(opts: StallNudgeOpts): NudgeHook;

// Path-free session seeding: pass an Item[] the caller has loaded.
function seedFromItems(harness: AgentHarness, threadId: string, items: Item[]): Promise<void>;
```

These moved from the now-deleted `packages/code-agent/src/tasks/runner-harness.ts` into core under Phase B; the old names `createRunnerSignal` / `runRunnerLoop` became `createDetachedSignal` / `runnableLoop`.

### Step registry

```typescript
function registerStep(step: Step): void;
function lookupStep(id: string): Step | null;
function getRegistry(): ReadonlyMap<string, Step>;
```

Step builders auto-register at construction; `lookupStep` is the cross-process contract for out-of-process adapters. Policy is **latest registration wins** on duplicate id — strict duplicate rejection is a tracked follow-up.

### Durable IPC (advanced)

`@noetic-tools/platform-node` additionally exposes `AgentIpcServer`, `AgentIpcClient`, the v2 wire protocol, and a `DurableOutboundQueue` primitive (via `createDurableOutboundQueue`). The server composes the queue when a `StorageAdapter` is supplied: outbound frames are numbered, persisted, and replayed from the client's last ack on reconnect. Protocol frames `durable`, `durableResume`, `durableAck` carry the wire envelope. See the framework/durability.mdx page for the full end-to-end pattern.

## Slot Constants

```typescript
const Slot = {
  REMINDER: 80,
  STEERING: 90,
  SCRATCHPAD: 100,
  ENTITY: 150,
  OBSERVATIONS: 200,
  PROCEDURAL: 250,
  EPISODIC: 300,
  RAG: 350,
  SEMANTIC_RECALL: 400,
} as const;
```

**`Slot.REMINDER` (80)** is reserved for layers that inject `<system-reminder>`-wrapped developer messages (turn-counter-throttled nags, plan-mode reminders, error-recovery hints). Reminder-slot layers maintain their own state and emit before any steering guidance.

Slot orders layers **within** a band; `placement` picks the band. A slot-90 live layer therefore renders after a slot-350 anchored one, because the whole anchor band precedes history and the whole live band follows it. Slot still decides order among layers sharing a band, and which output is dropped first when the band is over budget. See [Prompt-cache anchoring](#prompt-cache-anchoring-placement).

## Cross-layer state reads

`ExecutionContext.readLayerState<T>(layerId)` returns a sibling layer's current state (or `undefined`). Used when a layer needs to inspect another layer's progress — e.g. the CLI reminder layer reads `plan` to know whether plan mode is active:

```typescript
const planState = ctx.readLayerState<{ session?: { mode?: string } }>('plan');
if (planState?.session?.mode === 'planning') {
  // emit a plan-mode reminder
}
```

Treat returned values as read-only.

## CLI-specific context layers

These are shipped by `@noetic-tools/cli` on top of the core framework. The CLI is
developed in a separate repository (`github.com/mattapperson/noetic-internal`), so import
them from the published barrel — there is no `packages/cli` in this workspace.

### `reminderLayer(opts)`

```typescript
import { reminderLayer, createReminderRegistry, BUILTIN_TRIGGERS } from '@noetic-tools/cli';

const registry = createReminderRegistry();
for (const t of BUILTIN_TRIGGERS) registry.register(t);
registry.register({
  id: 'my-custom',
  minTurnsBetweenReminders: 10,
  timing: 'recall',
  shouldFire: ({ state }) => state.toolUsageCounts.get('Bash')! > 15 ? 'heavy Bash usage — consider dedicated tools' : null,
});

const layer = reminderLayer({ registry });
```

Emits `<system-reminder>`-wrapped developer messages based on registered triggers. `timing: 'recall'` fires on next turn; `timing: 'immediate'` fires via `onItemAppend` for faster reactivity.

### `agentMdLayer(opts)`

```typescript
import { agentMdLayer, loadAgentInstructions } from '@noetic-tools/cli';

const instructions = await loadAgentInstructions({ cwd, fs });
const layer = agentMdLayer({ loader: () => Promise.resolve(instructions) });
```

Surfaces `AGENT.md`, `.agent/rules/*.md`, and ancestor/user-global instruction files. Supports `@path.md` imports and skills-style `!command` inline execution (user-origin always; project-origin gated by `config.trustProjectEmbeddedCommands`). See `specs/12a-cli-context-layers.md` for full discovery order.

## CLI-specific tools

These are shipped by `@noetic-tools/cli` on top of the core framework, from the separate
CLI repository. The task tools are CLI-internal (not on the published barrel); the
signatures below describe the contract in `specs/21-tasks.md`, not an import you can make
from this workspace.

### `taskTools(opts)` — Task management

The `task_*` tool prefix gives agents 1:1 parity with the `noetic tasks <verb>` CLI. Tools are registered by the harness factory and are **default-on**; opt out via `tools.tasks: false` in `noetic.config.ts`. A read-only variant exposes only `task_show`, `task_list`, and `task_logs` — used in planning mode and other contexts where the agent must observe but not mutate.

```typescript
// TaskStoreContext — { fs: FsAdapter; projectRoot: string }
const ctx: TaskStoreContext = { fs, projectRoot };

// Full task surface (mutators + queries).
const tools = taskTools({ ctx });

// Read-only — only task_show, task_list, task_logs.
const ro = taskTools({ ctx, readOnly: true });
```

All tools resolve tasks by their `T-<10 chars>` id and return JSON-shaped objects. Each tool delegates to the same handler the CLI verb uses, so behaviour is identical across surfaces. Storage layout, atomicity guarantees, and lifecycle semantics are spelled out in `specs/21-tasks.md`.

#### Identity & state types

```typescript
type TaskSource = 'manual' | 'worktree';
type TaskReviewStatus = 'not_started' | 'reviewing' | 'needs_changes' | 'approved';
type TaskLifecycleStatus = 'active' | 'merged' | 'cleanup-blocked' | 'removed';
type KanbanColumn =
  | 'triage' | 'in_progress' | 'needs_changes' | 'ready_to_merge'
  | 'done' | 'cleanup_blocked' | 'removed' | 'archived';
```

Hierarchy entities use the same `<prefix>-<10 chars>` shape with prefixes `ML` (milestone), `SL` (slice), `F` (feature), `A` (assertion), `V` (validator run), `FX` (fix lineage), `IV` (interview session).

#### Mutating tools

```typescript
// task_create — create a manual task. Optional description seeds description.md.
input:  { title: string; description?: string }
output: { task: Task }

// task_move — atomic kanban move. Computes the minimum patch across
// archivedAt / lifecycleStatus / reviewStatus.
input:  { taskId: string; column: KanbanColumn }
output: { task: Task }

// task_merge — try `wt merge <branch>`; fall back to `git merge` if `wt`
// is missing. Both paths emit task:reviewStatusChanged on success.
input:  { taskId: string; branch?: string }
output: { task: Task; via: 'wt' | 'git' }

// task_log / task_comment / task_steer — append to log.jsonl. `task_steer`
// also writes/appends steering.md (read by the steering context layer when
// NOETIC_TASK_DIR points at this task).
input:  { taskId: string; message: string }
output: { entry: LogEntry }     // task_log, task_comment
output: { entry: LogEntry; steeringPath: string }  // task_steer

// task_attach — copy a file into <taskDir>/attachments/.
input:  { taskId: string; sourcePath: string }
output: { taskId: string; destinationPath: string }

// task_pause / task_unpause — toggle pause on the active agent-ci runner.
input:  { taskId: string }
output: { outcome: 'paused' | 'already_paused' | 'no_runner' | 'resumed' | 'already_running' }

// task_archive / task_unarchive — set/clear archivedAt.
input:  { taskId: string }
output: { task: Task }

// task_delete — hard-delete the task directory; emits task:archived
// before the rm -rf.
input:  { taskId: string }
output: { taskId: string; deleted: true }

// task_duplicate — copy task.json + description.md + attachments under a new id.
input:  { taskId: string; title?: string }
output: { task: Task }
```

#### Hierarchy tools

```typescript
// task_plan — run the live AI-driven interview to build a hierarchy.
// TUI-only; throws in headless contexts because the interview asks the
// user multiple-choice questions through AskUserService.
input:  { taskId: string; description?: string }
output: { taskId: string; hierarchy: TaskHierarchy }

// task_add_milestone — append a milestone.
input:  { taskId: string; title: string; verification: string; description?: string }
output: { milestone: Milestone }

// task_add_slice — append a slice under a milestone.
input:  { taskId: string; milestoneId: string; title: string; verification: string; description?: string }
output: { slice: Slice }

// task_add_feature — append a feature under a slice.
input:  { taskId: string; sliceId: string; title: string; acceptanceCriteria: string; description?: string }
output: { feature: Feature }

// task_add_assertion — append an assertion under a milestone, optionally
// covering specific feature ids.
input:  { taskId: string; milestoneId: string; title: string; assertion: string; featureIds?: string[] }
output: { assertion: Assertion }

// task_activate_slice — mark a slice 'active'; with triage:true, also
// triages every defined feature into a leaf task under the same parent.
input:  { taskId: string; sliceId: string; triage?: boolean }
output: { outcome: { sliceId: string; triagedFeatureIds: string[] } }

// task_autopilot — toggle the autopilot flag for a structured task.
input:  { taskId: string; enabled: boolean }
output: { task: Task }
```

#### Read-only tools

```typescript
// task_show — full record + recent log + hierarchy summary if present.
input:  { taskId: string; logTail?: number }
output: { task: Task; recentLog: LogEntry[]; hierarchy: TaskHierarchy | null }

// task_list — filterable list. Without filters, returns active tasks for
// the current project; --all surfaces archived too.
input:  {
  column?: KanbanColumn;
  source?: TaskSource;
  all?: boolean;
}
output: { tasks: Task[] }

// task_logs — tail of the most recent log entries.
input:  { taskId: string; n?: number }   // default n=50
output: { entries: LogEntry[] }
```

The full set is 23 tools, mirroring the 23 mutating + read CLI verbs (everything except `--help`). See `specs/21-tasks.md` for the verb table and the complete `Task` / `Milestone` / `Slice` / `Feature` / `Assertion` / `ValidatorRun` / `FixLineage` / `InterviewSession` schemas.

## Context Layer Hooks

### onItemAppend

Called when input items (user messages, tool outputs) are about to be appended to the ItemLog. Enables middleware-style item transformation and context re-rendering.

```typescript
interface OnItemAppendParams<TState> {
  items: Item[];         // Items to be appended (may be transformed by prior layers)
  log: ItemLog;          // Full log (read-only)
  ctx: ExecutionContext;
  state: TState;
}

interface OnItemAppendResult<TState> {
  items: Item[];           // Items to append (filter, transform, or inject)
  state?: TState;          // Updated layer state
  rerender?: boolean;      // Request context re-render
  timing?: 'immediate' | 'batched';  // When to apply re-render
  scope?: RerenderScope;   // Which layers to re-recall
}

type RerenderScope = 'self' | 'slot-after' | 'all';  // default: 'slot-after'
```

**Pipeline behavior:** Items flow through layers in slot order. Each layer receives the output of the previous layer. Returning an empty array stops the pipeline.

**Re-render triggers:** When `rerender: true`, the harness re-runs `recall()` for affected layers based on `scope`:
- `'self'`: Only the triggering layer
- `'slot-after'`: Triggering layer and all higher-slot layers (default)
- `'all'`: All layers

**Layer configuration:**
```typescript
interface ContextLayer<TState> {
  // ... other fields
  rerenderTiming?: 'immediate' | 'batched';  // default for this layer's re-renders
}
```

**Example: Content filtering**
```typescript
const contentFilter = {
  id: 'filter',
  slot: Slot.STEERING - 10,
  scope: 'execution',
  hooks: {
    async init() { return { state: null }; },
    async onItemAppend({ items }) {
      return {
        items: items.map(item => ({
          ...item,
          content: redactSensitive(item.content),
        })),
      };
    },
  },
} satisfies ContextLayer<null>;
```

**Example: Keyword-triggered context injection**
```typescript
const keywordWatcher = {
  id: 'keyword-watcher',
  slot: Slot.STEERING + 5,
  scope: 'execution',
  rerenderTiming: 'immediate',
  hooks: {
    async init() { return { state: { docs: [] } }; },
    async onItemAppend({ items, state }) {
      const keywords = extractKeywords(items);
      if (keywords.length === 0) return { items };
      
      const docs = await fetchRelevantDocs(keywords);
      return {
        items,  // pass through unchanged
        state: { docs },
        rerender: true,
        scope: 'self',
      };
    },
    async recall({ state }) {
      return {
        items: state.docs.map(d => createMessage(d.content, 'developer')),
        tokenCount: estimateTokens(state.docs),
      };
    },
  },
} satisfies ContextLayer<{ docs: Doc[] }>;
```

### renderDelta

Called for an anchored layer whose pinned output has gone stale, to describe the change compactly instead of re-sending the block. Signature, fallback behaviour, and when it earns its keep: [Prompt-cache anchoring](#prompt-cache-anchoring-placement).

## Per-Layer Context Usage (`ctx.lastLayerUsage`)

After every successful `callModel`, the runtime records a snapshot of how the context window decomposed across its contributors and stores it on `ctx.lastLayerUsage`. The same snapshot is mirrored on `HarnessResponse.lastLayerUsage` for callers that have already released the `Context`.

```typescript
interface LayerUsageEntry {
  readonly layerId: string;
  readonly tokenCount: number;
  readonly items: ReadonlyArray<Item>;
  readonly placement: 'anchor' | 'live';  // band the layer actually rendered into
  readonly served: 'fresh' | 'pinned';    // 'pinned' = a replay of an earlier render
  readonly changed: boolean;              // fresh output differed from the pin, so it was superseded
  readonly churnRate: number;             // share of watched assemblies that changed, 0–1
  readonly rebillTokens: number;          // tokens those changes would have re-billed unpinned
}

interface EpochUsage {
  readonly id: string;
  readonly age: number;          // assemblies served by this epoch, including this one
  readonly anchorTokens: number;
  readonly liveTokens: number;
  readonly deltaTokens: number;
  readonly reanchorReason?: ReanchorReason;  // set only on an assembly that re-anchored
}

interface LastLayerUsage {
  readonly executionId: string;
  readonly modelId: string;
  readonly layers: ReadonlyArray<LayerUsageEntry>; // sorted by layerId
  readonly systemPromptTokens: number;
  readonly toolsTokens: number;
  readonly historyTokens: number;
  readonly totalUsedTokens: number;
  readonly epoch?: EpochUsage;   // absent when contextCache is off
}
```

- `layers[i].tokenCount` comes from each context layer's own `recall()` `tokenCount`. For a pinned layer, `items` and `tokenCount` are the pinned bytes — what the model saw — not the fresh render.
- The other three buckets are estimated via the framework's 4-chars-per-token heuristic.
- `placement`, `served`, `churnRate`, and `epoch` are what a `/context` view needs to explain *why* a layer costs what it does — a high `rebillTokens` on an anchored layer is the saving anchoring bought.
- Use this to power introspection UIs (e.g., the CLI `/context` command). The snapshot is overwritten on the next call — export to your span if you need historical retention.

## ToolExecutionContext

Available inside tool `execute` functions:

```typescript
interface ToolExecutionContext {
  ctx: Context;                 // Step execution context (ctx.harness also available)
  harness: AgentHarness;        // AgentHarness instance (guaranteed non-undefined)
  fs: FsAdapter;                // Filesystem adapter (from harness)
  shell: ShellAdapter;          // Shell adapter (from harness)
  context: ToolContext;         // Per-layer state accessor (get/set by layer id)
  assembledView: Item[];        // Current conversation view
  lastStepMeta: StepMeta | null;
}
// Access harness params: toolCtx.harness.config.params
// Or via context: toolCtx.ctx.harness.config.params
// Filesystem: toolCtx.fs.readFileText('/path')
```

## CLI Plugin Hooks

Plugins loaded by `@noetic-tools/cli` implement the `NoeticPlugin` interface, exported
from that package's barrel (the CLI itself is developed in a separate repository, so
there is no `packages/cli` source to read here — see
`packages/web/content/docs/code-agent-cli/plugins.mdx` for the authored reference). The
hooks below aggregate contributions from every loaded plugin alongside the CLI's
built-ins.

### `lspServers?(ctx): ReadonlyArray<LspServerContribution>`

Register additional language servers beyond the four builtins (TypeScript/JavaScript,
Python, Go, Swift). Contributions share the same extension index as the
builtins — a plugin can **override** a builtin by reusing its `id`, or **add**
a new language by claiming a novel extension.

```typescript
import type { LspServerContribution } from '@noetic-tools/cli';

export default {
  name: 'my-rust-lsp',
  version: '1.0.0',
  lspServers: () => [
    {
      id: 'rust-analyzer',
      extensions: ['.rs'],
      rootMarkers: ['Cargo.toml', 'rust-project.json'],
      launch: {
        strategy: 'githubRelease',
        owner: 'rust-lang',
        repo: 'rust-analyzer',
        asset: (platform, arch) =>
          `rust-analyzer-${arch}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}.gz`,
        args: [],
      },
    },
  ],
} satisfies NoeticPlugin;
```

**`LaunchSpec` strategies** (pick one per contribution):

| strategy | use for | spawn behavior |
|---|---|---|
| `path` | toolchain-distributed binaries (gopls, sourcekit-lsp, rust-analyzer installed via rustup) | `which <bin>`; errors with `installHint` if absent |
| `bunx` | npm-distributed servers (typescript-language-server, pyright-langserver) | `bunx <bin> <args>` — zero-install |
| `githubRelease` | standalone prebuilt binaries | download from GitHub release, cache in `~/.noetic/lsp/<id>/<version>/`. Gated by `NOETIC_DISABLE_LSP_DOWNLOAD=1` |

**Conflict policy**: same `id` → plugin overrides builtin. Different `id` but
overlapping extension → first-registered wins (builtins register before
plugins). The single model-facing tool (`lsp`) stays constant — the operation
list, schemas, and output format never change across contributions.

## JSON Workflow Runtime

Portable JSON workflow definitions that can be generated by an LLM and executed by the harness.

### WorkflowDocumentSchema

```typescript
import { WorkflowDocumentSchema, validateWorkflow } from '@noetic-tools/core';

const doc = validateWorkflow({
  version: 1,
  root: { kind: 'callModel', id: 'step-1', instructions: 'Hello' },
});
```

Node kinds: `callModel`, `invokeTool`, `runCode`, `conditional`, `inParallel`, `spawn`, `withContext`, `loop`, `sequence`, `schedule`, `subflow`, plus `acp-agent`.

A `subflow` node runs another workflow document as one step — inline (`document`) or by name (`ref`, resolved lazily from `HydrationContext.workflows` / `parseAndRunWorkflow`'s `workflows` option). Exactly one of `document`/`ref` is required. Unknown refs raise `UNKNOWN_WORKFLOW_REFERENCE` at execution; ref cycles raise `WORKFLOW_CYCLE`. There is also a `workflow({ id, document | ref, tools?, layers?, workflows?, isolation?: 'inherit' | 'spawn' })` builder that runs a document as a composable `StepRunCode` (main entry only, not `/portable`).

### hydrateWorkflow / hydrateNode

```typescript
import { hydrateWorkflow, hydrateNode } from '@noetic-tools/core';
import type { HydrationContext } from '@noetic-tools/core';

const ctx: HydrationContext = {
  tools: new Map([['search', searchTool]]),
  executeStep: harness.run.bind(harness),
  // Optional: resolve acp-agent nodes and generative-UI output codecs.
  // acpAgents: createAcpAgentRegistry(claudeCode(), codex()),
  // uiLibraries: new Map([['dashboard-lib', openUi(dashboardLibrary)]]),
};

const step = hydrateWorkflow(doc, ctx);
```

A `callModel` node opts into a generative-UI codec with `output: { codec: 'openui', library: '<ref>' }`; the hydrator resolves `<ref>` from `ctx.uiLibraries` to a live `OutputCodec` and throws `UNKNOWN_UI_LIBRARY_REFERENCE` if it is unregistered. See [Generative UI](#generative-ui-openui).

**Named context layers.** Both `withContext` (`layers`, required) and `spawn` (`layers`, optional) node kinds resolve layer names from `ctx.layers` (a `ReadonlyMap<string, ContextLayer>`); an unregistered name throws `UNKNOWN_LAYER_REFERENCE`. A `spawn` node with no `layers` inherits the parent's layers — the default spawn behaviour; naming them replaces the inherited set for the child. Without `ctx.layers` supplied, named layers resolve to `[]` and the harness defaults apply.

### dynamicWorkflow

LLM generates a workflow as JSON, then the harness hydrates and executes it.

```typescript
import { dynamicWorkflow } from '@noetic-tools/core';

const agent = dynamicWorkflow({
  model: 'openai/gpt-4o',
  tools: [searchTool, calcTool],
  maxDepth: 5,
  maxRevisions: 3,
});
```

### parseAndRunWorkflow

Run a pre-built JSON workflow directly.

```typescript
import { parseAndRunWorkflow } from '@noetic-tools/core';

const result = await parseAndRunWorkflow({
  json: workflowJson,
  harness,
  ctx,
  tools: [searchTool],
});
```

Emits a root `workflow.run` trace span carrying the static DAG (`NoeticAttr.WORKFLOW_DOCUMENT`, `.WORKFLOW_NODES`, `.WORKFLOW_EDGES`). Per-call `llm.call` and `tool.call` spans nest under it. All are flushed to the harness `traceExporter` (default `NoopExporter`).

### UntilPredicateSchema

Named predicates for loop termination in JSON: `maxSteps`, `maxCost`, `maxDuration`, `noToolCalls`, `outputContains`, `outputEquals`, `converged`. Combinators: `any`, `all`.

## Generative UI (OpenUI)

`@noetic-tools/openui` makes an agent respond with a UI built from components you register, following the [OpenUI](https://www.openui.com) standard. It depends only on `@noetic-tools/context` + `@noetic-tools/types`; core sees two dialect-agnostic contracts (`OutputCodec`, `UiFragment`) and never imports the package. Three surfaces, adopted independently.

### Output codec on callModel

```typescript
import { createLibrary, defineComponent, openUi } from '@noetic-tools/openui';
import { z } from 'zod';

const library = createLibrary([
  defineComponent({ name: 'Card', description: 'Titled container', props: z.object({ title: z.string(), children: z.array(z.unknown()).optional() }) }),
  defineComponent({ name: 'Text', props: z.object({ value: z.string() }) }),
  defineComponent({ name: 'Stack', props: z.object({ children: z.array(z.unknown()) }) }),
]);

const dashboard = callModel({ id: 'dashboard', model: 'claude-sonnet-5', output: openUi(library) });
// output resolves to a UiDocument; the model emits OpenUI Lang, streamed as openui.* events.
```

`openUi(library): OutputCodec<UiDocument>` generates the system prompt from the component signatures, folds it into the step's instructions, keeps itself off the JSON-schema output format, and drives an incremental parser that emits `openui.node` / `openui.state` / `openui.query` framework events. `Query`/`Mutation` data bindings resolve against the step's own `tools` array.

### openUiSurface() — server-authoritative UI state

Install as a context layer so the SERVER owns the mounted document, reactive `$vars`, and interaction record — the client renderer is a projection of this state.

```typescript
import { openUiSurface, ui } from '@noetic-tools/openui';

const surface = openUiSurface({ library });   // ContextLayer<OpenUiSurfaceState>, slot 120, scope 'thread'

const harness = new AgentHarness({ name: 'ui', agentGraph: dashboard, params: {}, contextLayers: [surface] });
```

| Hook | Behavior |
|------|----------|
| `init` / `store` | load from + write through to `ScopedStorage` (thread scope → survives resume + reconnect) |
| `onItemAppend` | reduce client `ui-event` items into `vars`/`interactions`; drop keystroke noise; request immediate re-render |
| `recall` | render a budget-trimmed `<ui_surface>` block so the model sees the current UI |
| `projectHistory` | collapse superseded renders in history to a one-line placeholder |
| `afterModelCall` | validate each render against the library; guide/repair before the client sees it |

**Waiting for a submit** — predicates read the live surface, so the interaction loop is plain composition:

```typescript
const checkout = loop({
  id: 'checkout',
  steps: [callModel({ id: 'render', model, tools: [quoteShipping], output: openUi(library) })],
  until: ui.submitted(surface, 'checkout-form'),   // also: ui.interacted(surface, kind?), ui.toAssistant(surface)
});
```

### Tool-authored UI

A tool declares `ui` render functions so its calls/results carry their own fragments (like Claude Code tools rendering their own output). `fragment(library)` compiles typed constructors from the library's Zod schemas — a typo'd component or bad prop fails at typecheck.

```typescript
import { fragment } from '@noetic-tools/openui';
const f = fragment(library);

const quoteShipping = tool({
  name: 'quote_shipping', input: QuoteIn, output: QuoteOut, event: QuoteProgress,
  ui: {
    call: (args) => f.Card('Quoting…', [f.Text(args.carrier ?? '…')]),
    progress: (events) => f.Progress(events.at(-1)?.pct ?? 0),
    result: (out) => f.Table(out.quotes),
  },
  async *execute(args, ctx) { yield { pct: 40 }; return quotes; },
});
```

`ToolUiDeclaration` methods (`call`/`progress`/`result`/`error`) each return a `UiFragment | null`. The runtime emits them as `openui.fragment` framework events from BOTH model-requested tool calls and direct `invokeTool` steps — and works even without the codec installed (deterministic tool cards, zero prompt cost).

### Transport (`@noetic-tools/openui/server`)

`serveOpenUi(harness, { surface }): (request) => Promise<Response>` — a runtime-neutral (no `node:*`) fetch handler speaking the OpenUI wire protocol. `POST { prompt }` runs a turn and streams the surface as SSE; `POST { event }` ingests a client interaction; `GET` returns the current snapshot for reconnect rehydration. Pair with the client descriptor `noeticStreamAdapter()`.

### JSON workflow

A `callModel` node references a codec: `"output": { "codec": "openui", "library": "<ref>" }`, resolved from `HydrationContext.uiLibraries` (see [hydrateWorkflow](#hydrateworkflow--hydratenode)).
