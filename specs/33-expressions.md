# Expressions

> **Depends On:** `05-loop-and-until` (Until, Verdict), `09-error-model` (NoeticConfigError), `26-json-workflow-runtime` (WorkflowNode, hydration)
> **Exports:** `Expression`, `ExpressionSchema`, `evaluate`

---

## Purpose

A JSON workflow moves data between nodes as strings. Substring routes and
text appends alone describe only a finite-state machine. Expressions read and
build structured values, so a workflow can hold state and branch on it
exactly:

- the `compute` node (spec 26) turns its input into a new value,
- a `conditional` route's `when` (spec 26) picks a branch by an exact test,
- the `when` until predicate (spec 26) stops a loop by an exact test.

An expression is plain JSON. It is never `eval`'d, does no I/O, reads no clock
or randomness, and always gives the same result for the same input, so it runs
anywhere the runtime runs, Cloudflare Workers included. The op set is closed:
adding an op is a schema change.

The language is small on purpose. It can read and write paths in a value, do
arithmetic, compare, branch, and build lists, strings, and objects. That is
enough to simulate a two-counter (Minsky) machine — a state object holding a
program counter and two integer counters, a `conditional` that routes on the
counter with `when`, `compute` nodes that increment, decrement, and zero-test,
and a `loop` that runs until the program counter reaches a halt state — and so
enough for any computation the loop's iteration cap allows.

---

## The Input

An expression is evaluated against one value, its **input**:

- A string is parsed as JSON when it parses; otherwise the raw string is the
  input. `'{"n":1}'` is the object `{ "n": 1 }`, `'42'` is the number `42`,
  `'hello'` is the string `"hello"`.
- Any other value (for example a `decide` node's answers object) is the input
  as is.

The hydrator applies this rule before every evaluation, so nodes that pass JSON
text to one another read it as structured data.

---

## Encoding

Every expression is one of:

| Form            | Meaning                                                                   |
|-----------------|---------------------------------------------------------------------------|
| string, number, boolean, `null` | A literal: evaluates to itself.                          |
| array           | A list: each element is an expression, evaluated in order.                |
| object          | An op: exactly one key, the op name. Its value holds the op's arguments.  |

Op arguments are written one of three ways:

| Op       | Value                                     | Example                                    |
|----------|-------------------------------------------|--------------------------------------------|
| `get`    | One expression, evaluated to a path.      | `{ "get": "counter.a" }`                   |
| `quote`  | Any JSON, returned as is, never evaluated.| `{ "quote": { "get": "not an op" } }`      |
| `object` | A record of key → expression.             | `{ "object": { "n": { "get": "n" } } }`    |
| any other | An array of argument expressions.        | `{ "+": [{ "get": "n" }, 1] }`             |

Because an object is always an op, a literal object is written with `quote`
(fixed) or `object` (built from expressions). A literal list needs neither:
`[1, 2]` is the list `[1, 2]`, and `{ "quote": [1, 2] }` is the same list.

The schema enforces one key per op object and each op's argument count, so a
malformed expression fails `WORKFLOW_VALIDATION_FAILED` at parse time rather
than at execution.

### Paths

`get` and `set` take a path — a value naming a place inside another value:

- A **string** is split on `.`: `"counter.a"` is `["counter", "a"]`. The empty
  string is the empty path.
- A **list** of segments, each a string or an integer: `["counter", "a"]`,
  `["items", 0]`. Use the list form when a key holds a `.`.

The empty path names the whole value. A segment indexes a list when the value
at that point is a list; it must then be an integer, or a string of digits.
Otherwise it names an object key, which must be a string.

---

## Ops

All ops are pure: an op that "changes" a value returns a new value and leaves
its arguments untouched.

### Reading and building

| Op       | Arguments                    | Result                                                                 |
|----------|------------------------------|------------------------------------------------------------------------|
| `get`    | path                         | The value at the path in the input. A missing key or index fails.      |
| `quote`  | any JSON                     | That JSON, unevaluated.                                                 |
| `object` | record of expressions        | An object with each key's evaluated value.                              |
| `set`    | `[target, path, value]`      | A copy of `target` with `value` at the path. Missing object keys along the path are created as `{}`. A list index may be any existing index, or the list length to append. The empty path returns `value`. |
| `at`     | `[container, key]`           | A list's element or a string's character at an integer index (negative counts from the end), or an object's value at a string key. Out of range or missing fails. |
| `has`    | `[container, key]`           | `true` when `at` would succeed on that list or object, else `false`.    |
| `len`    | `[value]`                    | A string's length, a list's length, or an object's key count.          |

### Lists and strings

| Op       | Arguments                    | Result                                                                 |
|----------|------------------------------|------------------------------------------------------------------------|
| `push`   | `[list, value]`              | A new list with `value` appended.                                       |
| `slice`  | `[list or string, start, end?]` | The part from `start` up to (not including) `end`, with JavaScript `slice` rules: negative indexes count from the end, out-of-range indexes clamp. `{ "slice": [xs, 0, -1] }` drops the last element (a pop). |
| `concat` | `[a, b, ...]` (one or more)  | All strings joined, or all lists joined end to end. Mixing fails.      |

### Arithmetic

All arguments must be numbers, and every result must be finite.

| Op  | Arguments          | Result                                    |
|-----|--------------------|-------------------------------------------|
| `+` | one or more        | The sum.                                  |
| `-` | one or two         | The negation of one; the difference of two.|
| `*` | one or more        | The product.                              |
| `/` | two                | The quotient. Dividing by zero fails.     |
| `%` | two                | The JavaScript remainder (sign of the dividend). By zero fails. |

There is one number type (JSON's). Integers stay exact up to 2^53.

### Comparison

| Op                    | Arguments | Result                                                                |
|-----------------------|-----------|-----------------------------------------------------------------------|
| `==`, `!=`            | two       | Deep equality on any values: same type, same scalars, lists equal element by element, objects with the same keys and equal values. No coercion: `1` does not equal `"1"`. |
| `<`, `<=`, `>`, `>=`  | two       | Order on two numbers, or two strings (by UTF-16 code unit). Any other pair fails. |

### Logic

| Op    | Arguments              | Result                                                              |
|-------|------------------------|---------------------------------------------------------------------|
| `and` | one or more booleans   | `true` when all are `true`. Stops at the first `false`.              |
| `or`  | one or more booleans   | `true` when any is `true`. Stops at the first `true`.                |
| `not` | one boolean            | Its negation.                                                        |
| `if`  | `[cond, then, else]`   | `then` when `cond` is `true`, `else` when it is `false`. Only the taken branch is evaluated. |

### Truth

Only the boolean `true` is true and only `false` is false. A condition — an
`if` test, an `and`/`or`/`not` argument, a route's `when`, an until `when` —
that evaluates to anything else fails. There is no truthiness: `0`, `""`,
`null`, and `[]` are errors in a condition, not `false`.

---

## Errors

Every failure at evaluation throws a `NoeticConfigError` with code
`EXPRESSION_FAILED`. The message names the op, where the failing expression
sits as a JSON Pointer into the expression (`/` is the root; an op's argument
`i` is `<op location>/<op>/<i>`, an `object` entry `<op location>/object/<key>`),
and what was wrong:

```
Expression failed at /if/0/==/0 ('+'): argument 1 must be a number, got string.
Expression failed at / ('get'): no key 'b' at path 'a.b'.
```

A failure is raised for:

- an argument of the wrong type (`+` on a string, `len` on a number, …),
- a condition that is not a boolean,
- a missing key or out-of-range index in `get` or `at`, or a bad path,
- a non-finite arithmetic result, or a divisor of zero,
- a limit (below) being exceeded.

The hydrator prefixes the message with the workflow node id. Where the error
surfaces depends on the node (spec 26 § Expression Failures).

### Limits

Evaluation work is linear in the expression's size: there is no recursion,
looping, or user-defined function. Two limits bound it further:

| Limit               | Value  | Applies to                                                      |
|---------------------|--------|-----------------------------------------------------------------|
| Nesting depth       | 64     | Ops and lists nested inside one another.                        |
| Result length       | 10^6   | The length of a `concat` or `push` result (characters or elements), so doubling a value in each op cannot grow it without bound. |

---

## Schema

`ExpressionSchema` lives in `@noetic-tools/types` beside the workflow schema.
It is recursive and is emitted in the published JSON Schema as a named `$defs`
entry, `Expression`. Each op is a strict object (one key, no others), so the
JSON Schema rejects extra keys too.

```typescript
type Expression =
  | string | number | boolean | null
  | Expression[]
  | { get: Expression }
  | { quote: JsonValue }
  | { object: Record<string, Expression> }
  | { set: [Expression, Expression, Expression] }
  | { at: [Expression, Expression] }
  | { has: [Expression, Expression] }
  | { len: [Expression] }
  | { push: [Expression, Expression] }
  | { slice: [Expression, Expression] | [Expression, Expression, Expression] }
  | { concat: Expression[] }                       // one or more
  | { '+': Expression[] }                          // one or more
  | { '-': [Expression] | [Expression, Expression] }
  | { '*': Expression[] }                          // one or more
  | { '/': [Expression, Expression] }
  | { '%': [Expression, Expression] }
  | { '==': [Expression, Expression] }
  | { '!=': [Expression, Expression] }
  | { '<': [Expression, Expression] }
  | { '<=': [Expression, Expression] }
  | { '>': [Expression, Expression] }
  | { '>=': [Expression, Expression] }
  | { and: Expression[] }                          // one or more
  | { or: Expression[] }                           // one or more
  | { not: [Expression] }
  | { if: [Expression, Expression, Expression] };
```

---

## Evaluator

```typescript
function evaluate(expr: Expression, input: unknown): unknown
```

A plain, synchronous function in `@noetic-tools/core` (`expression/`). It
takes an already-read input (§ The Input) and returns the result, or throws
`EXPRESSION_FAILED`. Ops dispatch through a registry keyed by op name. Results
are JSON values; `evaluate` never mutates `expr` or `input`.

---

## Example

A loop body that moves one unit from `counter` to `sum` each turn:

```json
{
  "object": {
    "counter": { "-": [{ "get": "counter" }, 1] },
    "sum": { "+": [{ "get": "sum" }, { "get": "counter" }] }
  }
}
```

The same with `set`, keeping every other field of the input:

```json
{
  "set": [
    { "set": [{ "get": "" }, "sum", { "+": [{ "get": "sum" }, { "get": "counter" }] }] },
    "counter",
    { "-": [{ "get": "counter" }, 1] }
  ]
}
```

A test that the counter is zero: `{ "==": [{ "get": "counter" }, 0] }`.

---

## Design Notes

**Single-key op objects.** An op is `{ "<op>": args }`, as in JSON Logic,
rather than `{ "op": "add", "args": [...] }`. It is shorter for people and for
models to write, the op name reads first, and each op is its own strict schema
variant, so editors and validators check arity per op. The cost is that a
literal object cannot be written bare; `quote` and `object` cover that, and
workflow state built from expressions uses `object` or `set` anyway.

**Paths are values.** `get`'s argument is an expression like any other, so
`{ "get": "counter.a" }` is a literal path while
`{ "get": { "concat": ["regs.", { "get": "which" }] } }` picks the path at run
time. `at` gives one dynamic step into any value, not just the input.

**Strict types, no truthiness.** A workflow branch must be exact. Coercion
(`"1" == 1`, `0` as false) makes a misread field look like a valid answer;
failing instead surfaces the mistake at the node that made it.

**Errors as `NoeticConfigError`.** An expression failure is a mistake in the
document, like `INVALID_FORK_INPUT`, found at execution because only then is
the input known. It carries a code, a message, and a hint, the same as every
other document mistake.

---

## Cross-References

- `compute` node, `conditional` `when` routes, `when` until predicate: `26-json-workflow-runtime`
- Loop termination and predicate errors: `05-loop-and-until`
- `NoeticConfigError`: `09-error-model`

---

## Future Considerations

- **More ops.** Object key listing, string search and split, and number
  formatting would help text-heavy workflows. Each is a schema change and an
  entry in the op registry.
- **Bindings.** A `let` form naming a sub-result would avoid evaluating the
  same sub-expression twice in large expressions.
