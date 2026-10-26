# Expressions

> **Depends On:** `05-loop-and-until` (Until, Verdict), `09-error-model` (NoeticConfigError), `26-json-workflow-runtime` (WorkflowNode, hydration)
> **Exports:** `Expression`, `ExpressionSchema`, `ExpressionLimits`, `DEFAULT_EXPRESSION_LIMITS`

---

## Purpose

A JSON workflow moves data between nodes as text. Substring routes and text
appends alone describe only a finite-state machine. Expressions read and build
structured values, so a workflow can hold state and branch on it exactly.

Noetic does not define its own expression language. It embeds
[JSONata](https://docs.jsonata.org), a query and transformation language for
JSON, and this spec covers only how Noetic embeds it: where expressions
appear, what they read, how their results become node output, the limits they
run under, and the errors they raise. The language itself is documented at
https://docs.jsonata.org and is not restated here.

---

## Why JSONata

- **Precedent.** AWS Step Functions uses JSONata as the expression language of
  its JSON state machines (Amazon States Language). Noetic workflows are JSON
  state machines of the same kind, so the same choice carries over, along
  with its body of examples and tooling.
- **Model familiarity.** JSONata is old, stable, and widely written, so models
  write it well without a grammar in the prompt. A planner that emits a
  workflow document can emit its expressions too.
- **Fit.** An expression is one string. It reads paths, does arithmetic,
  compares, branches, and builds objects and arrays — what a workflow needs
  to carry state — and it does no I/O.
- **Runtime-neutral.** The library is plain JavaScript with no native or
  platform dependencies, so it runs wherever core runs.

---

## Version Pinning

`@noetic-tools/core` depends on `jsonata` at an exact version (`2.2.2`), not a
range. The meaning of a stored document must not change under it because a
transitive install picked up a newer release. Moving to a new JSONata version
is a deliberate core change, called out in its release notes.

All use of the library goes through one adapter,
`packages/core/src/expression/jsonata.ts`. No other module imports JSONata or
inspects its error objects.

---

## The Expression Type

```typescript
type Expression = string;
```

`ExpressionSchema` (in `@noetic-tools/types`) accepts any non-empty string.
The types package checks shape only and does not depend on JSONata, so it
stays free of the library. Core checks syntax (§ Validation).

---

## Where Expressions Appear

| Place                | Field                                   | Role                                                     |
|----------------------|-----------------------------------------|----------------------------------------------------------|
| `compute` node       | `expr`                                  | Computes the node's output from its input.               |
| `conditional` route  | `{ "expr": "<JSONata>", "target": … }`  | Takes the route when the expression gives `true`.        |
| `loop` until         | `{ "kind": "expr", "expr": "<JSONata>" }` | Stops the loop when the expression gives `true`.       |
| any node's `emitItems` | `{ "onStart"?: …, "onDone"?: … }`       | Computes an event or the final item the node emits.      |

A conditional route carries exactly one of `match` (substring) or `expr`. The
`expr` until predicate may appear inside `any` and `all` like any other
predicate. Node shapes and their hydration are specified in spec 26.

---

## The Input

Every expression is evaluated against one value, its **input**, read from the
node's input (for an until predicate, the loop's last output; for an `emitItems` hook,
the node's input or output) by one rule,
`readInput`:

- A string is parsed as JSON when it parses; otherwise the raw string is the
  input. `'{"n":1}'` is the object `{ "n": 1 }`, `'42'` is the number `42`,
  `'hello'` is the string `"hello"`.
- Any other value (for example a `decide` node's answers object) is the input
  as is.

Nodes pass JSON text to one another, so this rule lets each expression read
the previous node's output as structured data. In JSONata terms the input is
the context value: a bare path such as `n` reads its `n` field, and `$` is the
whole input.

---

## Results

### `compute`

The result becomes the node's output, written the way every node writes its
output:

| Result                       | Output                                        |
|------------------------------|-----------------------------------------------|
| string                       | The string itself.                            |
| `null`                       | The empty string.                             |
| number, boolean, object, array | Its JSON text.                              |
| no value (`undefined`)       | Fails with `EXPRESSION_FAILED`.               |
| function                     | Fails with `EXPRESSION_FAILED`.               |

JSONata gives no value when a path matches nothing. A `compute` node treats
that as a mistake rather than turning it into empty output, since it most
often means a misspelled field. A function has no JSON form.

Because output is text, a string result that is itself valid JSON (`"5"`,
`"true"`) reads back as that JSON value at the next node. Keep strings inside
an object to carry them as strings.

### `emitItems`

An `emitItems` hook's result is what the node emits (spec 26 § Emitting items).
`onStart` gives one event of the node's custom item and `onDone` its final
fields; without an item, `onDone` gives message text, written the way `compute`
writes output. Both read their value by the input rule: `onStart` the node's
input, `onDone` its output. In both, no value emits nothing instead of failing:
emitting is optional, so an `onDone` that reads `n % 2 = 0 ? 'even'` emits on
even iterations and stays quiet on odd ones. A function still fails with
`EXPRESSION_FAILED`.

### Tests

A route `expr` and an until `expr` are **tests**. A test passes on `true` and
fails on `false` or no value, so a path that matches nothing (`done` on an
object without a `done` field) reads as false. Any other result — a number,
string, object, array, or `null` — fails with `EXPRESSION_FAILED`. Noetic does
not apply JSONata's truthiness to tests: a branch must be exact, and coercion
(`0` as false, `"false"` as true) makes a misread field look like an answer.
Write the comparison out (`count > 0`, `$exists(error)`).

---

## Limits

Every evaluation runs under four limits:

| Limit     | Bounds                                                                                     | Default     |
|-----------|--------------------------------------------------------------------------------------------|-------------|
| `steps`   | Sub-expressions evaluated, counting every repeat. Independent of the clock.                | `1000000`   |
| `depth`   | How deep evaluation nests. A tail call does not nest: JSONata runs it in a loop.           | `500`       |
| `length`  | Items in one sequence (JSONata's result list), including a range.                          | `1000000`   |
| `timeout` | Wall-clock milliseconds for one evaluation.                                                | `1000`      |

`DEFAULT_EXPRESSION_LIMITS` holds the defaults. A host overrides any of them
through `expressionLimits` on `parseAndRunWorkflow`, `dynamicWorkflow`,
`workflow()`, or `HydrationContext`; subflows inherit them, and unset fields
keep their defaults:

```typescript
interface ExpressionLimits {
  timeout?: number;
  depth?: number;
  length?: number;
  steps?: number;
}
```

- Each value is a positive integer or `Infinity`, which lifts that one bound.
  Anything else throws `INVALID_EXPRESSION_LIMITS` when the expression
  compiles at hydration.
- Each evaluation starts with a fresh clock, depth, and step count.
- Tripping a limit fails the evaluation with `EXPRESSION_LIMIT_EXCEEDED`,
  naming the limit and its value. JSONata also refuses a range (`[1..n]`) of
  more than 10,000,000 items whatever `length` is.
- `steps`, `depth`, and `timeout` are checked as each sub-expression starts,
  so one built-in call (a large `$sort`) runs to its end before the next check.
- `steps` is the bound that holds everywhere. Endless tail recursion never
  deepens, and Workers freeze `Date.now()` during pure CPU work, so on Workers
  only `steps` stops `( $f := function($n){ $f($n + 1) }; $f(0) )`.
- A built-in that walks deeply nested input recurses natively; overflowing the
  JavaScript stack throws `EXPRESSION_LIMIT_EXCEEDED` rather than crashing.

The limits bound one evaluation, not a run. An expression cannot loop forever,
but the workflow around it can (§ Turing Completeness).

---

## Validation

Syntax is checked when a document is validated, not when an expression first
runs. After the schema accepts a document, core's `expressionErrors(root)`
walks the tree, compiles every `compute.expr`, route `expr`, until `expr`
(including those nested in `any` and `all`), and `emitItems` `onStart`/`onDone`, and lists one message per
expression that does not parse. `parseAndRunWorkflow` and `dynamicWorkflow`
treat a non-empty list as a validation failure, so a planner gets syntax errors
back in the same revision loop as schema errors.

Named `subflow` refs are not followed; their expressions compile when the
referenced document hydrates. Hydration compiles each expression once, and
every later evaluation reuses the compiled form.

---

## Errors

All four are `NoeticConfigError`s (spec 09): a mistake in the document,
carrying a code, a message, and a hint. The message names where the
expression sits (`compute node 'step'`, `route 0 of conditional node 'pick'`,
`until of loop node 'count'`, `emitItems of node 'tick'`) and quotes JSONata's own error code and
position.

| Code                         | When                                                                  |
|------------------------------|-----------------------------------------------------------------------|
| `WORKFLOW_VALIDATION_FAILED` | An expression does not parse (validation time, or hydration of an unvalidated document). |
| `EXPRESSION_FAILED`          | JSONata raises an error at evaluation; a `compute` gives no value or a function; a test gives a non-boolean. |
| `EXPRESSION_LIMIT_EXCEEDED`  | An evaluation trips one of its limits or JSONata's range cap, or overflows the JavaScript stack. |
| `INVALID_EXPRESSION_LIMITS`  | An `expressionLimits` value is not a positive integer or `Infinity` (hydration time). |

A JavaScript `Error` thrown inside a JSONata built-in while an expression
evaluates is that expression's failure and becomes `EXPRESSION_FAILED`. A
thrown value that is neither a JSONata error nor an `Error` is a defect, not a
document mistake; the adapter rethrows it unchanged. Where an evaluation error surfaces — a
failed step, a thrown route, a loop verdict — depends on the node and is
specified in spec 26 § Expression Failures.

---

## Workers Safety

Expressions must run on every runtime core supports, Cloudflare Workers
included. Workers forbid generating code from strings at run time, so neither
the adapter nor the library it embeds may call `eval`, `new Function`, or any
other code-from-string path while compiling or evaluating an expression.
JSONata parses an expression into a tree and interprets it; its own `$eval`
parses JSONata, not JavaScript. A guard test scans the JSONata build core
resolves for code-from-string calls, so a version bump that adds one fails CI.

Two runtime notes:

- `$base64encode` and `$base64decode` fall back to Node's `Buffer` and need
  the Workers `nodejs_compat` flag. Without it they throw, and the evaluation
  fails with `EXPRESSION_FAILED`.
- `$now()`, `$millis()`, and `$random()` read the clock and a random source;
  an expression that avoids them gives the same result for the same input.

---

## Turing Completeness

Expressions make JSON workflows Turing complete. A `loop` with
`"maxIterations": "infinity"` repeats without a static bound, a `compute` body
carries a state object of unbounded integers from one iteration to the next,
and an `expr` until predicate halts on that state exactly. That is enough to
run a two-counter (Minsky) machine, which can compute anything computable.
Recursive named subflows (spec 26 § Recursion) reach the same power.

Since halting cannot be decided ahead of time, bounds come from the run, not
the document: an aborted context, `maxCost` and `maxDuration` predicates,
`maxRecursionDepth`, and the expression limits above.

### Worked Examples

**A two-counter loop.** Sum the numbers from `n` down to `1`. The state holds
two counters, `n` and `sum`; each iteration moves one step, and the loop stops
when `n` reaches zero:

```json
{
  "version": 1,
  "root": {
    "kind": "loop",
    "id": "count",
    "maxIterations": "infinity",
    "body": { "kind": "compute", "id": "step", "expr": "{ 'n': n - 1, 'sum': sum + n }" },
    "until": { "kind": "expr", "expr": "n = 0" }
  }
}
```

Run with input `{"n":4,"sum":0}`, the loop passes through `{"n":3,"sum":4}`,
`{"n":2,"sum":7}`, and `{"n":1,"sum":9}`, and ends with `{"n":0,"sum":10}`.

**Any two-counter machine.** The same shape runs a whole machine whose program
is data. The state holds a program counter `pc`, the registers, and a program;
an `inc` instruction adds one to a register, a `dec` instruction jumps to
`zero` when its register is zero and otherwise subtracts one. One `compute`
expression runs one instruction:

```jsonata
(
  $i := prog[$$.pc];
  $i.op = "inc"
    ? $merge([$$, { "pc": $i.next, $i.reg: $lookup($$, $i.reg) + 1 }])
    : $lookup($$, $i.reg) = 0
      ? $merge([$$, { "pc": $i.zero }])
      : $merge([$$, { "pc": $i.next, $i.reg: $lookup($$, $i.reg) - 1 }])
)
```

With that expression as the loop body and `{ "kind": "expr", "expr": "pc < 0" }`
as the predicate, the input below adds `a` into `b` and halts with `pc` at
`-1`, `a` at `0`, and `b` at `5`:

```json
{
  "pc": 0, "a": 3, "b": 2,
  "prog": [
    { "op": "dec", "reg": "a", "next": 1, "zero": -1 },
    { "op": "inc", "reg": "b", "next": 0 }
  ]
}
```

**A recursive subflow.** The same sum, by recursion. A named workflow `sum`
returns its total at the base case and otherwise steps once and calls itself:

```json
{
  "version": 1,
  "root": {
    "kind": "conditional",
    "id": "base",
    "routes": [
      { "expr": "n = 0", "target": { "kind": "compute", "id": "done", "expr": "sum" } }
    ],
    "default": {
      "kind": "sequence",
      "id": "recurse",
      "steps": [
        { "kind": "compute", "id": "step", "expr": "{ 'n': n - 1, 'sum': sum + n }" },
        { "kind": "subflow", "id": "again", "ref": "sum" }
      ]
    }
  }
}
```

Registered under `sum` in `workflows` and run with `{"n":4,"sum":0}`, it
recurses four levels and outputs `10`. A larger `n` than `maxRecursionDepth`
allows fails with `WORKFLOW_RECURSION_LIMIT`.

---

## Design Notes

**Embed, don't invent.** A custom language would need its own grammar,
documentation, and examples, and models would know none of it. JSONata brings
all three, and a precedent in AWS Step Functions.

**Strings, not trees.** An expression is a JSONata source string, not a JSON
encoding of an expression tree. It is shorter to write and to read in a
document, and it is the form models already produce. The cost is that the
JSON Schema cannot check syntax; core's validation pass does.

**Strict tests.** JSONata's own truthiness is loose. Tests require a boolean
so that a misread field fails at the node that made the mistake instead of
silently picking a branch.

**Limits per evaluation.** An expression is one step of a workflow, so its
limits are small and fixed, and the workflow's own budgets bound the run.

---

## Cross-References

- `compute` node, `conditional` `expr` routes, `expr` until predicate, `emitItems`, Expression Failures: `26-json-workflow-runtime`
- Recursive named subflows and `maxRecursionDepth`: `26-json-workflow-runtime`
- Loop termination, verdicts, and the iteration cap: `05-loop-and-until`
- `NoeticConfigError`: `09-error-model`
- JSONata language reference: https://docs.jsonata.org

---

## Future Considerations

- **Host functions.** A host could register named, pure functions (for example
  a domain lookup) that expressions call as `$name(...)`, bound through
  JSONata's environment. Each would need the same Workers-safety and
  determinism rules as the language itself.
