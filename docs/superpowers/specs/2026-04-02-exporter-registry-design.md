# Exporter Registry — Zero-Code UI Tracing

**Goal:** `AgentHarness` auto-enables UI tracing when `NOETIC_UI_ENABLED=true` is set, no code change required. Zero overhead when disabled.

---

## Architecture

### Registration Pattern

`@noetic/core` provides a generic exporter factory registry. `@noetic/ui` registers its factory as a side-effect import, gated by `NOETIC_UI_ENABLED === 'true'`.

### `exporter-registry.ts` (core)

Module-level singleton with guardrails:

```typescript
let factory: (() => TraceExporter) | null = null;
let cached: TraceExporter | null = null;

function registerExporterFactory(f): void   // warns if overwriting
function getRegisteredExporter(): TraceExporter | null  // caches singleton
function clearExporterFactory(): void       // for testing
```

### `register.ts` (ui, side-effect)

```typescript
if (process.env.NOETIC_UI_ENABLED === 'true') {
  registerExporterFactory(() => new NoeticUITraceExporter({
    port: Number(process.env.NOETIC_UI_WS_PORT) || 3333,
    host: process.env.NOETIC_UI_HOST || 'localhost',
  }));
}
```

### Lazy Resolution in AgentHarness

Constructor stores explicit exporter or null. `run()` lazily resolves:

```
constructor: this.traceExporter = opts.traceExporter ?? null
run():       this.traceExporter ??= getRegisteredExporter() ?? new NoopExporter()
```

### `completeTrace` Lifecycle

Add `completeTrace?(traceId: string): void` to `TraceExporter` interface. Call it in `AgentHarness` after execution promise resolves/rejects.

## Cleanup

- Delete: `debug-harness.ts`, `debugger.ts`, `hook.ts`, debug types from `types.ts`
- Delete: `test/debugger.test.ts`
- Stub: `websocket.ts` debugger-registry usage (debug commands return "not supported")
- Add pause/resume/breakpoints to Future Enhancements in spec 21

## Files

| File | Action |
|------|--------|
| `packages/core/src/observability/exporter-registry.ts` | Create |
| `packages/core/src/types/observability.ts` | Add `completeTrace?` |
| `packages/core/src/runtime/agent-harness.ts` | Lazy resolve + completeTrace |
| `packages/core/src/index.ts` | Export registry functions |
| `packages/ui/src/runtime/register.ts` | Create |
| `packages/ui/src/index.ts` | Side-effect import |
| `packages/ui/src/runtime/debug-harness.ts` | Delete |
| `packages/ui/src/runtime/debugger.ts` | Delete |
| `packages/ui/src/runtime/hook.ts` | Delete |
| `packages/ui/src/runtime/types.ts` | Remove debug types |
| `packages/ui/src/service/websocket.ts` | Stub debug commands |
| `packages/ui/test/debugger.test.ts` | Delete |
| `specs/21-noetic-ui.md` | Update |
