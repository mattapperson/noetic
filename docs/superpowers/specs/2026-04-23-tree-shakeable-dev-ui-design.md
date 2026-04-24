# Tree-Shakeable Dev UI Runtime

**Goal:** Make `@noetic/ui/runtime` fully tree-shakeable so production builds never include dev UI code, WebSocket dependencies, or step extractor registrations.

---

## Problem

The current `@noetic/ui/runtime` entry point has three tree-shaking blockers:

1. **Side-effect import** — `index.ts` does `import './register'`, which unconditionally loads `register.ts` and all its transitive dependencies (including `NoeticUITraceExporter` and `ws`).
2. **Module-scope mutations** — `step-extractors.ts` calls `registerStepDataExtractor(...)` 8 times at module scope, mutating a global `Map`. Bundlers must preserve these.
3. **Barrel re-exports** — `index.ts` re-exports `NoeticUITraceExporter`, creating a static link to `exporter.ts` → `ws` even when the class is unused.

Combined, importing anything from `@noetic/ui/runtime` pulls in the entire module graph including the `ws` WebSocket library.

---

## Design

### `enableDevUI()` replaces side-effect registration

A single explicit function call replaces the side-effect import pattern. Users call it once in their entry point:

```typescript
import { enableDevUI } from '@noetic/ui/runtime/enable';

const devUI = enableDevUI({ port: 3333, host: 'localhost' });
```

The function:

1. Registers all 8 built-in step data extractors via `registerBuiltinExtractors()`
2. Registers the exporter factory with `@noetic/core` via `registerExporterFactory()`
3. Returns `{ disable(): void }` for cleanup (testing, teardown)

If `enableDevUI()` is never called, no side effects execute. The module is pure.

### No barrel files

Delete `packages/ui/src/runtime/index.ts`. All consumers import directly from the specific module:

```typescript
import { enableDevUI } from '@noetic/ui/runtime/enable';
import { NoeticUITraceExporter } from '@noetic/ui/runtime/exporter';
import { registerStepDataExtractor } from '@noetic/ui/runtime/step-extractors';
import type { ExporterOptions } from '@noetic/ui/runtime/types';
```

This gives bundlers the strongest signal — if `enable.ts` is not imported, `exporter.ts` and `ws` are unreachable from the module graph.

### Package exports

```json
"exports": {
  "./runtime/enable":          { "types": "./src/runtime/enable.ts", "default": "./src/runtime/enable.ts" },
  "./runtime/exporter":        { "types": "./src/runtime/exporter.ts", "default": "./src/runtime/exporter.ts" },
  "./runtime/step-extractors": { "types": "./src/runtime/step-extractors.ts", "default": "./src/runtime/step-extractors.ts" },
  "./runtime/types":           { "types": "./src/runtime/types.ts", "default": "./src/runtime/types.ts" },
  "./service":                 { "types": "./src/service/index.ts", "default": "./src/service/index.ts" },
  ".":                         { "types": "./src/service/index.ts", "default": "./src/service/index.ts" }
}
```

### `sideEffects` field

The `./service` entry point has `import.meta.main` CLI code at module scope, so the package-wide field must use the granular form:

```json
"sideEffects": ["./src/service/index.ts"]
```

---

## File Changes

### Delete

- `packages/ui/src/runtime/register.ts` — logic moves into `enableDevUI()`
- `packages/ui/src/runtime/index.ts` — barrel file, replaced by direct imports

### New: `packages/ui/src/runtime/enable.ts`

```typescript
import { registerExporterFactory, clearExporterFactory } from '@noetic/core';
import { NoeticUITraceExporter } from './exporter';
import { registerBuiltinExtractors, clearStepDataExtractors } from './step-extractors';
import type { ExporterOptions } from './types';

let enabled = false;

export function enableDevUI(options?: ExporterOptions): { disable(): void } {
  if (enabled) {
    console.warn('[noetic-ui] enableDevUI() already called — ignoring.');
    return { disable() {} };
  }
  enabled = true;

  registerBuiltinExtractors();
  registerExporterFactory(() => new NoeticUITraceExporter(options));

  return {
    disable(): void {
      clearExporterFactory();
      clearStepDataExtractors();
      enabled = false;
    },
  };
}
```

`enable.ts` statically imports `exporter.ts`. This is acceptable because:

- `@noetic/ui` is a **dev dependency** — absent from production `node_modules`
- For bundled deploys (serverless, edge), `sideEffects` + dead-code elimination handles removal
- Anyone importing `enable.ts` wants the exporter — the cost is expected

### Modified: `packages/ui/src/runtime/step-extractors.ts`

Move the 8 built-in `registerStepDataExtractor(...)` calls from module scope into a guarded function:

```typescript
let builtinsRegistered = false;

export function registerBuiltinExtractors(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;

  registerStepDataExtractor('llm', ...);
  registerStepDataExtractor('tool', ...);
  registerStepDataExtractor('fork', ...);
  registerStepDataExtractor('loop', ...);
  registerStepDataExtractor('spawn', ...);
  registerStepDataExtractor('branch', ...);
  registerStepDataExtractor('run', ...);
  registerStepDataExtractor('provide', ...);
}
```

The `Map` allocation (`const registry = new Map()`) stays at module scope — bundlers treat this as side-effect-free.

### Modified: `packages/ui/package.json`

- Update `exports` to per-file runtime paths (see above)
- Add `"sideEffects": ["./src/service/index.ts"]`
- Remove `"main"` and `"types"` top-level fields (the `.` export handles this)

---

## API Behavior

### Idempotency

Second call warns and returns a no-op `disable()`. Does not overwrite the first registration.

### Call ordering

`enableDevUI()` must be called **before** `AgentHarness` resolves its exporter. The harness calls `getRegisteredExporter()` lazily (on first run), so calling `enableDevUI()` at app startup is sufficient. Calling it after the harness has already resolved to `NoopExporter` has no effect on that harness instance.

### `disable()`

Calls `clearExporterFactory()` and `clearStepDataExtractors()`. Resets the `enabled` flag so `enableDevUI()` can be called again. Intended for test teardown.

### Consumer pattern (env-var gating)

```typescript
import { enableDevUI } from '@noetic/ui/runtime/enable';

if (process.env.NOETIC_UI_ENABLED === 'true') {
  enableDevUI({
    port: Number(process.env.NOETIC_UI_WS_PORT) || 3333,
    host: process.env.NOETIC_UI_HOST || 'localhost',
  });
}
```

In unbundled environments (Bun, Node), the `if` prevents execution but `enable.ts` is still loaded. This is fine — you're in dev mode with `@noetic/ui` installed. In bundled environments, the bundler replaces the env var at build time, dead-code-eliminates the branch, and `sideEffects` metadata lets it drop the unused import.

---

## Tests

### Tree-shaking verification tests

New test file: `packages/ui/test/tree-shaking.test.ts`

These tests verify the module purity guarantees that make tree-shaking possible:

1. **No side effects on import** — Importing `step-extractors.ts` does not register any built-in extractors (registry is empty after import)
2. **`enableDevUI()` registers extractors** — After calling `enableDevUI()`, all 8 built-in extractors are present
3. **`enableDevUI()` registers exporter factory** — After calling, `getRegisteredExporter()` returns a `NoeticUITraceExporter`
4. **`disable()` cleans up** — After calling `disable()`, the exporter factory and extractors are cleared
5. **Idempotency** — Second `enableDevUI()` call warns and does not overwrite
6. **Re-enable after disable** — `enableDevUI()` works again after `disable()` is called

### Updated existing tests

`test/step-extractors.test.ts` — The "built-in extractors" tests currently assume extractors are registered at module load. These must call `registerBuiltinExtractors()` in a `beforeEach` (with `clearStepDataExtractors()` in `afterEach`) since registration is no longer automatic.

---

## Doc/Spec Updates

### `specs/21-noetic-ui.md`

- **Integration Points** section: Replace side-effect import and `await import()` examples with `enableDevUI()`
- **Implementation Strategy** section: Replace dynamic import pattern with `enableDevUI()` pattern
- **Step Data Extractor Plugins** section: Update import paths from `@noetic/ui/runtime` to `@noetic/ui/runtime/step-extractors`
- Remove all references to `import '@noetic/ui/runtime'` as a side-effect registration pattern
- Document call-ordering requirement and `disable()` API

### `packages/ui/README.md`

- **Connect Your Agent** section: Replace with `enableDevUI()` example
- Remove dynamic import example
- Update all import paths to direct modules
- Update project structure (no `index.ts` in runtime)

### `packages/ui/RUNTIME_SUMMARY.md`

- Update tree-shaking section
- Update all code examples to use direct imports and `enableDevUI()`

### `docs/superpowers/specs/2026-04-02-exporter-registry-design.md`

- Update to reflect that `register.ts` side-effect pattern is replaced by `enableDevUI()`

---

## Migration

Clean break — no deprecation shim. This is pre-1.0. The side-effect `import '@noetic/ui/runtime'` pattern stops working silently (no runtime error, but no dev UI either). The fix is one line: replace the import with `enableDevUI()`.
