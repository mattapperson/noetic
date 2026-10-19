# Decide and Route Switch

> **Depends On:** `01-step-type` (Step<I,O>), `02-step-variants` (Lazy, step.llm view assembly), `03-control-flow` (branch), `07-context-and-event-log` (Context, StepMeta), `08-runtime` (AgentHarness), `11-context-layer-system` (ContextLayer, ProjectionPolicy), `26-json-workflow-runtime` (WorkflowNode)
> **Exports:** `step.decide()`, `step.routeSwitch()`, `decisionsHistoryLayer()`, `StepDecide`, `DecideQuestion`, `BooleanQuestion`, `ChoiceQuestion`, `ScoreQuestion`, `DecideAnswers`, `BooleanAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `Refusal`, `DecideRequest`, `DecideResponse`, `DecisionMeta`, `DecisionRecord`

---

## Purpose

`decide` asks a model typed questions about the current context and returns
typed answers with probabilities. `step.llm` produces text and tool calls for the
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

## `step.decide()`

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

function decide<TContext, I, const Q extends DecideQuestions>(
  opts: StepDecideOpts<TContext, Q>,
): StepDecide<TContext, I, DecideAnswers<Q>>;
```

```typescript
const triage = step.decide({
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

Question ids are the keys of `questions`. `step.decide()` throws
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
| Typed layer data | `context` selector | one named JSON state entry per key |

`view: 'full'` runs the same recall, `projectHistory`, budget, and projector path
as `step.llm` (see `02-step-variants`, "What the LLM Actually Sees"), shared via
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

---

## `step.routeSwitch()`

Routes to one of several steps by a decision. Each case receives the
**original input**, not the answers.

```typescript
type RouteKey<Q extends DecideQuestions> = {
  [K in keyof Q]: Q[K] extends ChoiceQuestion | BooleanQuestion | ScoreQuestion ? K : never;
}[keyof Q];

// Key form: route by one question; cases must cover every outcome.
function routeSwitch<TContext, I, O, Q extends DecideQuestions, K extends RouteKey<Q>>(opts: {
  id: string;
  decide: StepDecide<TContext, I, DecideAnswers<Q>>;
  on: K;
  cases: Record<CaseKeyOf<Q[K]>, Step<TContext, I, O>>;
  minConfidence?: number;
  uncertain?: Step<TContext, I, O>;
}): StepBranch<TContext, I, O>;

// Function form: combine answers; `default` is required.
function routeSwitch<TContext, I, O, Q extends DecideQuestions, C extends string>(opts: {
  id: string;
  decide: StepDecide<TContext, I, DecideAnswers<Q>>;
  on: (answers: AnsweredAll<Q>) => C;
  cases: Partial<Record<C, Step<TContext, I, O>>>;
  default: Step<TContext, I, O>;
  uncertain?: Step<TContext, I, O>;
}): StepBranch<TContext, I, O>;
```

`CaseKeyOf` is the choice literals for a choice question, `'true' | 'false'` for
a boolean question, and the level labels for a score question (routed by
`level`). `AnsweredAll<Q>` is `DecideAnswers<Q>` with `Refusal` removed: the
function form handles refusals before `on` runs.

```typescript
const handleTicket = step.routeSwitch({
  id: 'route-ticket',
  decide: triage,
  on: 'destination',
  cases: { billing, 'technical-support': support, sales, spam: drop },
  minConfidence: 0.6,
  uncertain: askHuman,
});

const escalate = step.routeSwitch({
  id: 'escalate',
  decide: triage,
  on: (a) => (a.isUrgent.value && a.urgency.value >= 1.5 ? 'page' : 'queue'),
  cases: { page: pageOnCall, queue: handleTicket },
  default: handleTicket,
});
```

### Semantics

1. Runs `decide` with the step input, through the interpreter, so the decision
   gets its own span, ledger entry, and `onDecision` notification.
2. Key form: if the routed answer is a `Refusal`, or `minConfidence` is set and
   the answer's confidence is below it, takes `uncertain`. Confidence is
   `confidence` for choice and score, and `max(probability, 1 − probability)` for
   boolean.
3. Otherwise takes the case for the answer.
4. Function form: a `Refusal` in any answer takes `uncertain`, or `default` when
   `uncertain` is unset. Otherwise `on` runs, and a returned key with no case
   takes `default`.
5. The chosen case runs with the original input; its output is the switch's
   output.

`step.routeSwitch()` throws `NoeticConfigError` at build time when
`minConfidence` is set without `uncertain`, or when `minConfidence` is outside
`[0, 1]`. With no `uncertain`, a refusal on the key form falls through to a
no-op (`null` route), matching `branch`.

`routeSwitch` builds a `StepBranch` with `_optimizable: [decide, ...cases]`, so
tree walks (tool collection, GEPA) see every child. It is not a new step kind.

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
}
```

`decide` is a step kind rather than a builder over `step.llm` because an `llm`
step appends to the item log, runs steering, and has no place for decision
metadata. `executeDecide`:

1. Resolves `model` (`step.model ?? harness.config.decisionModel`); an empty
   result throws `NoeticConfigError` `MISSING_MODEL`.
2. Builds state per "State: What the Model Sees".
3. Calls `ctx.harness.decide(request)`.
4. Validates the response: every question answered or refused, every choice and
   level known, probabilities in `[0, 1]`. A violation throws `llm_parse_error`.
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
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

type DecideStatePart =
  | { type: 'text'; text: string; name?: string }
  | { type: 'json'; value: unknown; name: string }
  | { type: 'image'; imageUrl: string };

interface DecideResponse {
  answers: Readonly<Record<string, BooleanAnswer | ChoiceAnswer<string> | ScoreAnswer<string> | Refusal>>;
  source: 'native' | 'estimated';
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
distributions map directly onto answers.

**Estimated.** For any other model, the adapter makes one structured-output
`callModel` per sample, asking for a probability per boolean, choice, and level,
then averages across `samples`. `source` is `'estimated'`. Self-reported
probabilities are not calibrated; use them for routing thresholds, not for
measurement.

Whether a model is native comes from its OpenRouter `decision` output modality,
cached per harness.

### Errors

| Condition | Error |
|-----------|-------|
| No model on step or harness | `NoeticConfigError` `MISSING_MODEL` |
| Invalid question set | `NoeticConfigError` (build time) |
| Malformed or incomplete response | `llm_parse_error` |
| Provider rate limit | `llm_rate_limit` |
| Provider rejects the request (e.g. images on a text-only model) | `step_failed` |
| Context aborted mid-call | `cancelled` |

A per-question refusal is an answer, not an error.

---

## `decisionsHistoryLayer()`

Writes decisions back into the context system, so later steps can read them and
later `llm` steps can see them.

```typescript
function decisionsHistoryLayer(opts?: {
  id?: string;                 // default 'decisionsHistory'
  scope?: ContextScope;        // default 'execution'
  maxRecords?: number;         // default 50, oldest dropped first
  recall?: boolean;            // render a summary into the view; default true
  slot?: number;               // default Slot.WORKING_MEMORY + 10
}): ContextLayer<DecisionsHistoryState>;

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

Any layer can implement it; `decisionsHistoryLayer` is the built-in one. In a
`fork`, decisions recorded in a path reach the parent through the layer's
`onReturn`, like any other layer state.

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
  uncertain?: WorkflowNode;
}
```

The `context` selector and the function form of `on` are closures and have no
JSON form. Hydration checks that `on` names a question and that `cases` covers
every outcome, and fails with a schema error otherwise.

---

## Observability

Each `decide` step opens a `decide` span (see `10-observability`) with:

- `gen_ai.request.model`, token usage, and cost, as on `llm` spans
- `noetic.decision.source` — `native` or `estimated`
- per question: `noetic.decision.<id>.value` and `noetic.decision.<id>.confidence`
  (or `.probability`)
- `noetic.decision.refused` — refused question ids

`routeSwitch` stamps `noetic.route.case` with the case taken, or `uncertain`.

---

## Relationship to Existing APIs

- **`aiCondition`** (`16-semantic-conditions`) is a one-question boolean decide:
  it calls `ctx.harness.decide` with the serialized input as its only state and
  returns `value`. A malformed response throws `llm_parse_error`.
- **`semanticSwitch`** stays: it routes by embedding similarity, without a model
  call, and suits cheap high-volume routing where labels are enough.
- **`branch`** stays the general primitive; `routeSwitch` is a `branch` built
  from a decision.
- **Eval judges** (`17-eval-and-optimization`) can use a score question for
  graded scorers. Question `instructions`, choice descriptions, and level
  descriptions are prompts, and GEPA treats them as optimizable text.

---

## Future Considerations

- **Box questions.** Jev answers `box` questions (an image bounding box with
  confidence). Add once a second provider supports it.
- **Decision fallbacks.** Gateway-style fallback lists (native model first, then
  a chat model) on `DecideRequest`.
- **Calibration for the estimated path.** Fit estimated probabilities against
  native answers from eval runs.
