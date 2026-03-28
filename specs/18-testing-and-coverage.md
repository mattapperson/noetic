# Testing and Coverage

> **Depends On:** `17-eval-and-optimization` (completes the package set)
> **Exports:** (none — process spec only)

---

## Overview

This spec defines the testing strategy, coverage policy, and CI requirements for the Noetic monorepo. It covers `@noetic/core`, `@noetic/eval`, and `@noetic/web`.

---

## Test Taxonomy

Four tiers with explicit scope constraints:

| Tier | Scope | Allowed imports | Packages |
|------|-------|-----------------|----------|
| Unit | Single module | Mocks from `_helpers.ts`, no I/O | core, eval |
| Integration | Multiple modules wired | Real `AgentHarness`, no network | core, eval |
| Functional | Full public API in-process | No network; scripted model via `createScriptedCallModel` | core, eval |
| E2E | Running application | HTTP/build only | web |

`@noetic/core` and `@noetic/eval` have no E2E tier.
`@noetic/web` has no unit/integration tier.

### Functional Tier Requirements

The functional tier has two distinct sub-concerns that must both be present:

- **Composition tests** — assert that builder outputs produce the expected step tree structure (e.g., `react()` creates a loop step with tool-call branches). Cheaper, catches builder bugs without running the interpreter.
- **Execution tests** — run the full tree through `AgentHarness` with a scripted model.

AI-generated tests tend to produce only execution tests. Both are required.

```typescript
// Composition test example
const step = react({ model: 'gpt-4o', tools: [searchTool] });
assert.equal(step.kind, 'loop');
assert.equal(step.body.kind, 'llm');

// Execution test example
const harness = new AgentHarness();
const ctx = await harness.run(step, input);
assert.equal(ctx.output, expectedOutput);
```

---

## Coverage Approach

**Policy**: Coverage is enforced as a diff gate, not hardcoded thresholds. CI fails if per-file coverage drops more than 2 percentage points from the stored baseline. This prevents threshold rot and catches incremental uncovered additions.

The initial baseline is established by running `bun test --coverage --coverage-reporter=json` and storing the output in `.noetic/coverage-baseline.json`. A small `scripts/check-coverage-diff.ts` script compares current JSON output to baseline and exits non-zero if any file regresses beyond the allowed delta.

### Initial Floor Thresholds

For the initial CI gate (before a baseline exists), minimum floor thresholds are enforced:

```typescript
// @noetic/core — floors, not targets
branches: 85   // HIGHEST: runtime has complex control flow, error model has 10 kinds
lines: 80
functions: 80

// @noetic/eval — lower floor: CLI + some adapters require live LLM
branches: 75
lines: 75
functions: 75
```

> **Invariant**: Branches are set HIGHER than lines/functions for this codebase. The error model (10 kinds × propagation rules), loop control flow (`onError: retry/skip/abort`), and fork modes are where runtime bugs hide. The industry standard of "branch lower than lines" is inverted here intentionally.

### Coverage Exclusions

Coverage excludes the following targeted paths (not blanket adapter exclusion):

- `**/_helpers.ts`
- `**/index.ts` (barrel re-exports)
- `**/cli/cli.ts` (CLI entrypoint, requires live filesystem)
- `packages/eval/src/adapters/**` ONLY when guarded by `test.skipIf(!HAS_API_KEY)` — unit mock tests for adapters run always and are included

### Adapter Test Pattern

```typescript
// CORRECT: unit mock always runs, live test skips without key
const HAS_API_KEY = !!process.env['OPENROUTER_API_KEY'];

describe('openRouterAdapter', () => {
  it('translates tool_call items to openrouter format', () => {
    // mock-based, always runs, included in coverage
  });

  it.skipIf(!HAS_API_KEY)('live: calls API and returns response', async () => {
    // live test, skipped in CI without key
  });
});
```

---

## Required Test Invariants

### Error Kind Coverage

> **Invariant**: For any function that can throw a typed `NoeticError`, at least one test must assert each error kind the function can produce, checking `e.noeticError.kind` explicitly. The 10 error kinds defined in `09-error-model.md` must each appear in at least one test in the error model test suite.

```typescript
// CORRECT
try {
  await harness.run(step, input);
  assert.fail('expected error');
} catch (e) {
  assert(e instanceof NoeticError);
  assert.equal(e.noeticError.kind, 'max-steps-exceeded');
}
```

### Side Effect Assertions

> **Invariant**: For any test that calls a function with side effects on `Context` (accumulating tokens, cost, items, or step metadata), at least one assertion must target a side effect — not just the return value.

```typescript
// CORRECT
const ctx = await harness.run(step, input);
assert.equal(ctx.output, 'expected');
assert(ctx.tokens.total > 0);  // side effect assertion required
```

Assertable side effects: `ctx.itemLog.items`, `ctx.tokens`, `ctx.cost`, `ctx.lastStepMeta`.

### Semantic Condition Testing

> **Invariant**: `aiCondition`, `semanticRoute`, `semanticSwitch`, and `embeddingMatch` must always be tested via injected mock implementations (using `mockEmbed()` from `_helpers.ts`). Never skip semantic condition tests.

### `until` Predicate Boundary Tests

> **Invariant**: Any test of a predicate that includes a numeric threshold (e.g., `maxSteps(N)`) must include boundary assertions at N-1, N, and N+1 iterations.

```typescript
// CORRECT
for (const [iterations, expected] of [[N-1, false], [N, true], [N+1, true]]) {
  assert.equal(predicate.check(makeCtx(iterations)), expected);
}
```

### Step Tree Mutation Tests

> **Invariant**: For any test of `mutator.ts` logic, at least one assertion must verify that the mutated step tree produces output different from the original — detecting whether the mutation actually took effect.

### Helper Factory Boundary

> **Invariant**: Shared structural mocks (`Context`, `ItemLog`, `LLMResponse`, `Step`) must use `_helpers.ts` factories. Test-local factories are permitted only for test-specific closures.

---

## Script Conventions

| Script | Command | Purpose |
|--------|---------|---------|
| `test` | `bun test` | Fast, no coverage |
| `test:coverage` | `bun test --coverage --coverage-reporter=text --coverage-reporter=json` | Local + baseline generation |
| `test:ci` | `bun test --coverage --coverage-reporter=json` | CI: diff enforcement |

> **Note**: `--bail` is NOT used in `test:ci`. Bailing on first failure truncates coverage data for remaining tests, making coverage reports from CI unreliable and threshold/diff enforcement impossible on incomplete data.

---

## Web Package Testing

The docs site (`@noetic/web`) uses build verification and link checking. No Playwright until interactive features (search, code playgrounds) are added.

- **Build gate**: `bun run build` — exits non-zero on MDX compilation errors, missing imports, type errors
- **Link check**: `bunx lychee --offline content/**/*.mdx` — catches broken internal doc links without HTTP requests

Scripts:

| Script | Command | Purpose |
|--------|---------|---------|
| `test:build` | `bun run build` | Build verification |
| `test:links` | `bunx lychee --offline 'content/**/*.mdx'` | Link checking |

---

## Eval Regression CI Gate

`@noetic/eval` includes a baseline regression system (`saveBaseline`, `loadBaseline`, `compareToBaseline`). CI must use it:

- **On PRs**: Run `noetic test --regression` if `.noetic/baselines/` exists; emit warning if scores degrade but do not block merge
- **On merge to main**: Block if any baseline score regresses by more than the configured threshold

Policy: score degradation is information on PRs; it is a blocker on main.

---

## Known Risks

### Bun JSON Coverage Reporter

Bun's `--coverage-reporter=json` flag must be verified against the project's Bun version. If unavailable, the `check-coverage-diff.ts` script parses the text output or LCOV instead. In that case, `--coverage-reporter=lcov` is the fallback (mature, well-documented format).

### `lychee` availability in CI

`lychee` is a Rust binary. In GitHub Actions, it can be installed via the `lychee-action`. If this proves too slow in CI, replace with `bunx broken-link-checker` (npm package, slower but zero install cost).
