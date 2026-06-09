# Testing Rules

## Setup

- **Framework**: `bun test` (Bun's built-in test runner)
- **Location**: Tests live in `test/` directory
- **Extension**: `.test.ts`
- **Run**: `bun test` (package level)

## Requirements

- Plain functions should always be tested
- Do not use `any` in tests
- Use `assert` for optional properties, not if statements

## Scripts

All scripting should be done in TypeScript.

## Coverage

- Run `bun test --coverage` to generate a coverage report
- Coverage is enforced as a diff gate (fail if per-file drops > 2pp from baseline)
- Initial floors: `@noetic-tools/core` 85% branches, 80% lines/functions; `@noetic/eval` 75% all
- Branches threshold is set HIGHER than lines — control flow and error paths are where runtime bugs hide
- Coverage excludes: `_helpers.ts`, `**/index.ts`, `**/cli/cli.ts`
- Adapter tests: unit mock tests always run (included in coverage); live tests use `test.skipIf(!HAS_API_KEY)`

## Required Test Invariants

1. **Error kinds**: Every `NoeticError` kind a function can throw must have a negative test checking `e.noeticError.kind`
2. **Side effects**: Tests calling functions with Context side effects must assert at least one of: `ctx.itemLog.items`, `ctx.tokens`, `ctx.cost`, `ctx.lastStepMeta`
3. **Semantic conditions**: Always tested via injected mocks (`mockEmbed()` from `_helpers.ts`), never skipped
4. **Predicate boundaries**: Numeric threshold predicates need boundary tests at N-1, N, N+1
5. **Mutation observable**: Mutator tests must assert the mutation is visible in output
6. **Helpers**: Shared structural mocks use `_helpers.ts`; test-local factories only for closure-specific state
7. **Functional tier completeness**: Both composition tests (tree structure) and execution tests are required

## E2E Tests (`@noetic/web`)

- Build gate: `bun run build` (catches MDX errors)
- Link check: `bunx lychee --offline content/**/*.mdx`
- No Playwright until interactive features ship

## Script Conventions

All Node packages must expose:
- `test` — fast, no coverage (existing)
- `test:coverage` — text + lcov output, no enforcement
- `test:ci` — lcov output, NO bail flag

> Bun's coverage reporter accepts only `text` and `lcov` (the `json` reporter was
> removed in Bun 1.3). Use `lcov` for machine-readable CI output.
