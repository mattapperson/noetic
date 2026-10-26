# Decide and Route Switch

> **Depends On:** `01-step-type` (Step<I,O>), `02-step-variants` (Lazy, callModel view assembly), `03-control-flow` (conditional), `07-context-and-event-log` (Context, StepMeta), `08-runtime` (AgentHarness), `11-context-layer-system` (ContextLayer, ProjectionPolicy), `26-json-workflow-runtime` (WorkflowNode)
> **Exports:** `decide()`, `routeSwitch()`, `decisionsHistoryLayer()`, `StepDecide`, `DecideQuestion`, `BooleanQuestion`, `ChoiceQuestion`, `ScoreQuestion`, `DecideAnswers`, `BooleanAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `Refusal`, `DecideRequest`, `DecideResponse`, `DecisionMeta`, `DecisionRecord`

---

## Purpose

`decide` asks a model typed questions about the current context and returns
typed answers with probabilities. `callModel` produces text and tool calls for the
conversation; `decide` produces a small value for the program to branch on, and
leaves the conversation untouched.

Three question types cover the three shapes of a decision:

| Question  | Shape        | Answer                                                     |
|-----------|--------------|------------------------------------------------------------|
| `boolean` | conditional  | `value: boolean`, `probability` of yes                     |
| `choice`  | switch       | `value: K`, `confidence`, a probability per choice         |
| `score`   | ordered scale | `value` (weighted level position), `level: L`, `confidence`, a probability per level |

These map onto dedicated decision models — TypeSafe Jev (`noul`/`choice`/`score`)
and OpenAI Decisions (`predicate`/`choice`/`score`) — which answer in one pass,
return calibrated distributions rather than sampled text, and bill no output
tokens. Any chat model can also answer, with estimated probabilities (see
"Model Paths").

---

## `decide()`

```typescript
interface StepDecideOpts<TContext, Q extends DecideQuestions> {
  id: string;
  /** Decision model id. Falls back to `harness.config.decisionModel`. */
  model?: Lazy<string, TContext>;
  /** Shared framing for every question. */
  instructions?: Lazy<string | undefined, TContext>;
  questions: Q;
  /** Which part of the assembled view the model sees. Default `'full'`. */
  view?: 'full' | 'layers' | 'none';
  /** Typed state read from context layers, sent as named state entries. */
  context?: (ctx: Context<TContext>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Budget for the decision's view. Default: `DECISION_PROJECTION`. */
  projection?: ProjectionPolicy;
  /** Runs per decision on the estimated path, averaged. Ignored on the native path. Default 1. */
  samples?: number;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

function decide<const Q extends DecideQuestions, TContext = ContextData, I = unknown>(
  opts: StepDecideOpts<TContext, Q>,
): DecideStep<TContext, I, Q>;
```

The question map is the first type parameter so it is always inferred: passing
type arguments would otherwise reset it to `DecideQuestions` and erase every
literal. Pass none; type `ctx.context` by annotating the selector,
`context: (ctx: Context<MyContext>) => …`. An empty question map is a type
error.

```typescript
const triage = decide({
  id: 'triage',
  model: 'typesafe/jev-1.14',
  instructions: 'Support ticket triage.',
  context: (ctx) => ({ plan: ctx.context.billing.plan }),
  questions: {
    destination: {
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      choices: {
        billing: 'Refunds, invoices, plan changes',
        'technical-support': 'Bugs, outages, errors',
        sales: 'Pricing, demos, upgrades',
        spam: 'Unsolicited or irrelevant',
      },
    },
    isUrgent: {
      type: 'boolean',
      instructions: 'Is the customer reporting downtime or severe frustration?',
      threshold: 0.7,
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is this ticket?',
      levels: [
        { label: 'low', description: 'Can wait days' },
        { label: 'medium', description: 'Needs an answer today' },
        { label: 'high', description: 'Drop everything' },
      ],
    },
  },
});
```

### Questions

```typescript
type DecideQuestions = Readonly<Record<string, DecideQuestion>>;
type DecideQuestion = BooleanQuestion | ChoiceQuestion | ScoreQuestion;

interface BooleanQuestion {
  type: 'boolean';
  instructions?: string;
  /** What yes and no mean. Required when `instructions` is absent. */
  criteria?: { true?: string; false?: string };
  /** Probability at or above which `value` is `true`. Default 0.5. */
  threshold?: number;
}

interface ChoiceQuestion<K extends string = string> {
  type: 'choice';
  instructions?: string;
  /** 1–255 options: bare values, or values mapped to descriptions. */
  choices: readonly K[] | Readonly<Record<K, string>>;
}

interface ScoreQuestion<L extends string = string> {
  type: 'score';
  instructions?: string;
  /** 2–10 levels, lowest first. */
  levels: readonly L[] | ReadonlyArray<{ label: L; description?: string }>;
}
```

Score levels are an array, never a record: JavaScript orders integer-like keys
(`'1'`, `'2'`) before other keys, so a record cannot carry an order. Choices have
no order, so a record is safe there.

Question ids are the keys of `questions`. `decide()` throws
`NoeticConfigError` at build time for an empty question map, a boolean question
with neither `instructions` nor `criteria`, a choice count outside 1–255, a
level count outside 2–10, duplicate choices or levels, or a `threshold` outside
`[0, 1]`.

### Answers

```typescript
type DecideAnswers<Q extends DecideQuestions> = {
  readonly [K in keyof Q]: AnswerFor<Q[K]> | Refusal;
};

interface BooleanAnswer {
  type: 'boolean';
  value: boolean;          // probability >= threshold
  probability: number;     // P(yes), [0, 1]
}

interface ChoiceAnswer<K extends string> {
  type: 'choice';
  value: K;                // highest-probability choice
  confidence: number;
  probabilities: Readonly<Record<K, number>>;
}

interface ScoreAnswer<L extends string> {
  type: 'score';
  value: number;           // probability-weighted level index, 0 = lowest
  level: L;                // highest-probability level
  confidence: number;
  probabilities: Readonly<Record<L, number>>;
}

interface Refusal {
  type: 'refusal';
}
```

The choice and level literals are inferred from the question, so
`answers.destination.value` is `'billing' | 'technical-support' | 'sales' | 'spam'`.

Probabilities are the business value of a decision, so they live in `O` (see the
`O` contract in `01-step-type`). A model may decline one question; that question
answers `Refusal` and the rest answer normally. The type forces callers to
handle it.

`confidence` is the provider's own certainty measure, not the top probability:
Jev can answer `billing: 0.6, shipping: 0.4` with `confidence: 0.2`. The
estimated path reports the top probability as `confidence`.

`level` is the most probable level, not `value` rounded: a split distribution
(`low: 0.45, high: 0.55`) has `value` 1.1 but `level` `'high'`.

---

## State: What the Model Sees

`decide` takes no `state` argument. It reads state from the context system:

| Source | Controlled by | Sent as |
|--------|---------------|---------|
| Step input `I` | always | first state entry (strings verbatim, other values as JSON) |
| Layer recall output | `view: 'full' \| 'layers'` | state entries in slot order |
| Projected history | `view: 'full'` | state entries, oldest first |
| Typed layer data | `context` selector | one JSON state entry named `context` |

`view: 'full'` runs the same recall, `projectHistory`, budget, and projector path
as `callModel` (see `02-step-variants`, "What the LLM Actually Sees"), shared via
one view-assembly function. `'layers'` keeps layer recall and drops history.
`'none'` sends only the input, `instructions`, and the `context` selector.

The view is budgeted with `DECISION_PROJECTION` (8,000 tokens, `overflow:
'truncate'`) unless `projection` overrides it. Decision models degrade on long
state — Jev switches to a slower, less accurate long-context mode above about
32 KB of text — so a decision sees a tighter window than a chat turn does.

Image parts in view items pass through as image state. A text-only model rejects
images; that surfaces as `step_failed`.

### No Conversation Side Effects

- The input is **not** appended to `ctx.itemLog`, and no response items are
  appended. A decision observes the conversation; it never joins it.
- Steering hooks (`beforeToolCall`, `afterModelCall`) do not run. Decide calls
  are internal classifier calls with no tools.
- Layer `store()` does not run. Layers learn about decisions through
  `onDecision` (below).
- Layer recall **peeks** (`RecallOptions.peek`): each `recall` gets a copy of
  its state, state it returns is not committed, and eventual-layer output is not
  cached. The steering layer drains its queue in place as it renders; without a
  peek, a decision would eat guidance meant for the next `callModel` call. A layer
  whose state cannot be copied (it holds functions) is left out of the view.
- `ctx.lastStepMeta` is **merged**, not replaced: `usage`, `cost`, and
  `decision` are set, and the previous step's `toolCalls` stay, so a loop's
  `until.noToolCalls()` still sees them.

### Reuse Within an Execution

A decide step asked the same thing again — same step id, same input, and the
same conversation length — in one execution returns its earlier answers
without calling the model. Two nested `routeSwitch`es over one decision pay
once and cannot disagree. A loop that asks again after new items land gets a
fresh decision. Inputs that do not survive JSON are never reused.

A decide step used as a loop's `until` (below) is the exception: the loop
drops its earlier answers before each ask, so every iteration gets a fresh
decision even when the output and conversation length repeat.

### Ending a Loop

A decide step asking exactly one boolean question can be a loop's `until`,
alone or inside `any()`/`all()`, in code and in JSON (`05-loop-and-until`,
Ending a Loop with a Decision; `26-json-workflow-runtime`, Decide Nodes as
Predicates). There is no wrapper: the step `decide()` returns, or the plain
`decide` workflow node, is the decider. It runs on the iteration's output; yes
stops the loop, and no or a refusal continues it. A decider with more than one
question, or a non-boolean one, fails with `INVALID_UNTIL_DECIDER`. All the
rules above hold: no conversation side effects, a merged `ctx.lastStepMeta`,
and a `decide.call` span per ask.

---

## `routeSwitch()`

Routes to one of several steps by a decision. Each case receives the
**original input**, not the answers.

```typescript
// Key form: route by one question. `cases` needs exactly one step per outcome,
// and `uncertain` is required.
function routeSwitch<TContext, const Q, const K extends keyof Q & string, const Cases, U>(opts: {
  id: string;
  decide: DecideStep<TContext, unknown, Q>;
  on: K;
  cases: Cases;                // keys: exactly CaseKeyOf<Q[K]>
  minConfidence?: number;
  uncertain: U;
}): StepConditional<TContext, StepInput<Cases[keyof Cases] | U>, StepOutput<Cases[keyof Cases] | U>>;

// Function form: combine answers; `default` is required.
function routeSwitch<TContext, const Q, const C extends string, const Cases, D, U = D>(opts: {
  id: string;
  decide: DecideStep<TContext, unknown, Q>;
  on: (answers: AnsweredAll<Q>) => C;
  cases: Cases;                // keys: a subset of C
  default: D;
  uncertain?: U;
}): StepConditional<TContext, StepInput<Cases[keyof Cases] | D | U>, StepOutput<Cases[keyof Cases] | D | U>>;
```

The switch's output type is the union of every case's output, so cases may
return different things. A missing case, a misspelled extra case, or an `on`
that names no question is a type error.

`CaseKeyOf` is the choice literals for a choice question, `'true' | 'false'` for
a boolean question, and the level labels for a score question (routed by
`level`). `AnsweredAll<Q>` is `DecideAnswers<Q>` with `Refusal` removed: the
function form handles refusals before `on` runs.

```typescript
const handleTicket = routeSwitch({
  id: 'route-ticket',
  decide: triage,
  on: 'destination',
  cases: { billing, 'technical-support': support, sales, spam: drop },
  minConfidence: 0.6,
  uncertain: askHuman,
});

const escalate = routeSwitch({
  id: 'escalate',
  decide: triage,
  on: (a) => (a.isUrgent.value && a.urgency.value >= 1.5 ? 'page' : 'queue'),
  cases: { page: pageOnCall, queue: handleTicket },
  default: handleTicket,
});
```

### Semantics

1. Runs `decide` with the step input through the `run` argument every conditional
   route receives (see `03-control-flow`), so the decision gets its own span,
   ledger entry, and `onDecision` notification.
2. Key form: if the routed answer is a `Refusal`, or `minConfidence` is set and
   the answer's confidence is below it, takes `uncertain`. Confidence is the
   provider's `confidence` for choice and score. A boolean has none, so it is the
   probability of the side `value` picked — `probability` for yes, `1 −
   probability` for no — which respects the question's `threshold`.
3. Otherwise takes the case for the answer.
4. Function form: a `Refusal` in any answer takes `uncertain`, or `default` when
   `uncertain` is unset. Otherwise `on` runs, and a returned key with no case
   takes `default`.
5. The chosen case runs with the original input; its output is the switch's
   output.

`routeSwitch()` throws `NoeticConfigError` at build time:

| Code | Condition |
|------|-----------|
| `EMPTY_STEP_ID` | empty `id` |
| `UNKNOWN_ROUTE_QUESTION` | key form: `on` names no question of `decide` |
| `INCOMPLETE_ROUTE_CASES` | key form: an outcome of `on` has no case |
| `INVALID_MIN_CONFIDENCE` | `minConfidence` outside `[0, 1]` |
| `MISSING_UNCERTAIN_STEP` | key form: no `uncertain` |

Requiring `uncertain` means every outcome of the key form — refusal and low
confidence included — runs a typed case; the switch never passes its input
through as if it were a case's output. Case lookup uses own keys only, so a
choice named `constructor` or `toString` routes like any other.

`routeSwitch` builds a `StepConditional` with `_optimizable: [decide, ...cases,
uncertain?, default?]`, so tree walks (tool collection, GEPA) see every child.
It is not a new step kind. Its route closes over the cases, so it also sets
`_rebuild` — rebuild around new children, in `_optimizable` order — and an
optimizer that swaps a child gets a switch that runs the swap. It needs `decide`
to carry its literal questions,
which is what `decide()` returns:

```typescript
type DecideStep<TContext, I, Q extends DecideQuestions> =
  StepDecide<TContext, I, DecideAnswers<Q>> & { readonly questions: Q };
```

---

## The `decide` Step Kind

```typescript
interface StepDecide<TContext = ContextData, _I = unknown, O = unknown> {
  kind: 'decide';
  id: string;
  model?: Lazy<string, TContext>;
  instructions?: Lazy<string | undefined, TContext>;
  questions: DecideQuestions;
  view: 'full' | 'layers' | 'none';
  context?: (ctx: Context<TContext>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  projection?: ProjectionPolicy;
  samples: number;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
  /** Phantom field carrying the answers type for inference. Never set at runtime. */
  readonly _answers?: O;
}
```

`decide()` throws `NoeticConfigError` `EMPTY_STEP_ID`, `MISSING_MODEL` (an
empty eager model), `INVALID_DECIDE_QUESTIONS`, or `INVALID_DECIDE_SAMPLES` (not
a positive integer).

`decide` is a step kind rather than a builder over `callModel` because a `callModel`
step appends to the item log, runs steering, and has no place for decision
metadata. `executeDecide`:

1. Resolves `model` (`step.model ?? harness.config.decisionModel`); an empty
   result throws `NoeticConfigError` `MISSING_MODEL`.
2. Builds state per "State: What the Model Sees", recalling layers with
   `{ peek: true }` (see "No Conversation Side Effects").
3. Opens a `decide.call` span and calls `ctx.harness.decide(request)`.
4. Validates the response: every question answered or refused, every choice and
   level known, probabilities in `[0, 1]`. A violation throws `model_parse_error`.
5. Rolls usage and cost into `ctx.tokens` / `ctx.cost`, sets
   `ctx.lastStepMeta.decision`, and stamps the span.
6. Notifies layers via `onDecision`.
7. Returns the answers.

### `DecisionMeta`

```typescript
interface StepMeta {
  // ...existing fields
  decision?: DecisionMeta;
}

interface DecisionMeta {
  modelId: string;
  /** `native`: a decision model's distribution. `estimated`: a chat model's self-report. */
  source: 'native' | 'estimated';
  refused: readonly string[];   // question ids
}
```

---

## Harness Contract

```typescript
interface AgentHarnessContract {
  // ...existing members
  decide(request: DecideRequest): Promise<DecideResponse>;
  /** Run every layer's `onDecision` hook, in slot order. */
  notifyDecision(layers: ContextLayer[], record: DecisionRecord, ctx: Context): Promise<void>;
}

interface AgentConfig {
  // ...existing fields
  /** Default model for `decide` steps. */
  decisionModel?: string;
}

interface DecideRequest {
  model: string;
  instructions?: string;
  state: ReadonlyArray<DecideStatePart>;
  questions: DecideQuestions;
  samples?: number;
  signal?: AbortSignal;
}

type DecideStatePart =
  | { type: 'text'; text: string; name?: string }
  | { type: 'json'; value: unknown; name: string }
  | { type: 'image'; imageUrl: string };

interface DecideResponse {
  answers: Readonly<Record<string, BooleanAnswer | ChoiceAnswer<string> | ScoreAnswer<string> | Refusal>>;
  source: 'native' | 'estimated';
  modelId: string;             // the model that answered, as the provider reports it
  usage: { inputTokens: number; outputTokens: number };
  cost?: number;
}
```

`DecideRequest` uses Noetic's vocabulary. Provider wire formats (`noul` vs
`predicate`, `criteria` vs `choices`/`levels`, keyed vs ordered answers) are
translated inside the adapter and never leak into step code.

### Model Paths

**Native.** For decision models, the OpenRouter adapter calls
`client.alpha.decisions.create` from `@openrouter/sdk` (1.x). The response
distributions map directly onto answers. On a durable harness the call leaves a
dispatch record before it is sent (`23-durable-execution` § Paid dispatches). The
provider sends a decision's generation id only with its body, so a native call
cut off mid-request cannot be priced later: it is held at its ceiling until
written off. Estimated calls are `callModel` rounds and are recorded as such.

**Estimated.** For any other model, the adapter makes one structured-output
`callModel` per sample, asking for a probability per boolean, choice, and level,
then averages across the samples that parsed. A sample that fails or does not
parse costs only itself. When no sample succeeds, the decision fails: with
`DecideOutputError` if some replied but none parsed, else with the first
provider error. `source` is `'estimated'`. Self-reported
probabilities are not calibrated; use them for routing thresholds, not for
measurement.

A model is native when OpenRouter's `models.get` lists `decisions` among its
output modalities. The answer is cached per harness, so each model id costs one
request. A lookup that fails (other than a 404) is not cached: the call takes
the estimated path and the next call asks again.

On the native path only an explicit provider refusal becomes a `Refusal`. A
missing or mistyped answer is left out, so validation raises `model_parse_error`
rather than passing a provider fault off as the model declining. Every answer's
`probabilities` has an entry for every outcome (0 when the provider sent none);
a choice or score sent without a distribution puts all the weight on the chosen
choice or the level the score rounds to. A one-sided boolean `criteria` cannot
be sent as criteria, so it joins the instructions (`Yes means: …`).

On the estimated path a boolean estimates `{ yes }` and choices and scores
estimate one probability per outcome. Choice and score probabilities are
normalized to sum to 1, `confidence` is the top probability, and a score's
`value` is the probability-weighted level index. A response that does not match
the requested shape throws `DecideOutputError` (`@noetic-tools/types`), which the
interpreter turns into `model_parse_error`. The error carries the samples' usage
and cost, and the step counts them: a failed decision still shows what it spent.
Its `decide.call` span is ended and exported either way.

### Errors

| Condition | Error |
|-----------|-------|
| No model on step or harness | `NoeticConfigError` `MISSING_MODEL` |
| Invalid question set | `NoeticConfigError` (build time) |
| Malformed or incomplete response | `model_parse_error` |
| Provider rate limit | `model_rate_limit` |
| Provider rejects the request (e.g. images on a text-only model) | `step_failed` |
| Context aborted mid-call | `cancelled` |

A per-question refusal is an answer, not an error.

---

## `decisionsHistoryLayer()`

Writes decisions back into the context system, so later steps can read them and
later `callModel` steps can see them.

```typescript
function decisionsHistoryLayer<const Id extends string = 'decisionsHistory'>(opts?: {
  id?: Id;
  scope?: ContextScope;        // default 'execution'; 'thread'/'resource' persist across runs
  maxRecords?: number;         // default 50, oldest dropped first
  recall?: boolean;            // render a summary into the view; default true
  slot?: number;               // default Slot.WORKING_MEMORY + 10
}): DecisionsHistoryLayer<Id>;
```

The layer keeps its literal id even inside `context([decisionsHistoryLayer()])`,
so `ctx.context.decisionsHistory` is typed and a misspelled key is an error.
`init` loads saved state from the layer's storage, so a `'thread'`-scoped history
survives across runs.

```typescript

interface DecisionRecord {
  stepId: string;
  at: number;                  // epoch ms
  modelId: string;
  source: 'native' | 'estimated';
  answers: DecideResponse['answers'];
}
```

`provides`:

| Key | Kind | Value |
|-----|------|-------|
| `latest` | data | `Readonly<Record<string, DecisionRecord>>` — newest record per step id |
| `all` | data | `ReadonlyArray<DecisionRecord>` — oldest first |

```typescript
const record = ctx.context.decisionsHistory.latest.triage;
```

Recall renders one line per step id, newest record only:

```
Decisions so far:
- triage: destination=billing (0.81), isUrgent=yes (0.92), urgency=medium (1.3)
```

Both `provides` entries are data, not functions, so the layer adds no LLM tools.

### `onDecision` Hook

A new optional `ContextLayerHooks` member, called after every `decide` step
completes, in slot order:

```typescript
interface ContextLayerHooks<TState> {
  // ...existing hooks
  onDecision?(params: OnDecisionParams<TState>): Promise<{ state: TState } | undefined>;
}

interface OnDecisionParams<TState> {
  state: TState;
  record: DecisionRecord;
  ctx: ExecutionContext;
}
```

Any layer can implement it; `decisionsHistoryLayer` is the built-in one. Its
`onSpawn` gives an inParallel path or spawn child the parent's records, and its
`onReturn` merges back only the records the child added, so concurrent paths
keep each other's decisions.

A decision replayed from the step ledger on resume does not fire `onDecision`
again; the history it wrote comes back with the checkpoint. A harness restoring
an execution keeps the restored layer state on its first layer init rather than
starting the layers fresh.

---

## JSON Workflow Nodes

Questions are already plain JSON, so both builders have workflow nodes (see
`26-json-workflow-runtime`).

```typescript
interface DecideWorkflowNode {
  kind: 'decide';
  id: string;
  model?: string;
  instructions?: string;
  questions: Record<string, DecideQuestion>;
  view?: 'full' | 'layers' | 'none';
  samples?: number;
}

interface RouteSwitchWorkflowNode {
  kind: 'routeSwitch';
  id: string;
  decide: DecideWorkflowNode;
  on: string;                              // question id; key form only
  cases: Record<string, WorkflowNode>;
  minConfidence?: number;
  uncertain: WorkflowNode;
}
```

The `context` selector and the function form of `on` are closures and have no
JSON form. Schema validation checks that `on` names a question, that `cases`
covers every outcome, and that `uncertain` is present.

A `decide` node is also a valid until predicate on a `loop` node when it asks
exactly one boolean question (see Ending a Loop).

A `decide` node outputs the answers object. The JSON runtime handles it: a
`sequence` passes it to the next node as JSON (so a `callModel` node reads it), a
`conditional` matches routes against the answers' string values only — never the
keys or probability maps, which name every choice — and a `inParallel`'s `concat`
merge writes object results as JSON.

---

## Observability

Each `decide` step opens a `decide.call` span under `ctx.span` (see
`10-observability`) with:

- `noetic.node.id` — the step id

- `gen_ai.request.model`, token usage, and cost, as on `callModel` spans
- `noetic.decision.source` — `native` or `estimated`
- per question: `noetic.decision.<id>.value` and `noetic.decision.<id>.confidence`
  (or `.probability`)
- `noetic.decision.refused` — refused question ids

`routeSwitch` adds a `route_switch` event to `ctx.span` with `stepId` and
`case` — the case taken, `uncertain`, or `default`.

---

## Relationship to Existing APIs

- **`aiCondition`** (`16-semantic-conditions`) is a one-question boolean decide:
  it calls `ctx.harness.decide` with the serialized input as its only state and
  returns `value`. A refusal counts as no. A malformed response throws
  `model_parse_error` and a provider failure `step_failed`, both with step id
  `aiCondition`; an abort throws `cancelled`. A failed estimate's usage is still
  counted.
- **`semanticSwitch`** stays: it routes by embedding similarity, without a model
  call, and suits cheap high-volume routing where labels are enough.
- **`conditional`** stays the general primitive; `routeSwitch` is a `conditional` built
  from a decision.
- **Eval judges** (`17-eval-and-optimization`) can use a score question for
  graded scorers.
- **GEPA** treats a decide step's eager `instructions` as candidate text, at the
  path `<step path>.instructions`, as it does for `callModel` steps.

---

## Future Considerations

- **Box questions.** Jev answers `box` questions (an image bounding box with
  confidence). Add once a second provider supports it.
- **Decision fallbacks.** Gateway-style fallback lists (native model first, then
  a chat model) on `DecideRequest`.
- **Optimizable question text.** Question `instructions`, choice descriptions,
  and level descriptions are prompts too; expose them to GEPA as candidates.
- **Calibration for the estimated path.** Fit estimated probabilities against
  native answers from eval runs.
