# Spec ↔ Code ↔ Docs Sync

**CRITICAL:** These rules MUST be followed for ALL code changes.
They are mandatory, not optional.

## Requirements

1. **Code ↔ Spec**: When changing runtime code, update the corresponding spec if behavior diverges. When a spec changes, update the implementation to match.
2. **Code → Docs**: When code changes alter public API surface, behavior, or configuration, update the corresponding doc pages.
3. **Spec → Docs**: When a spec is added or revised, ensure the docs reflect the new specification.

## Reference Mapping

| Spec | Source | Docs |
|------|--------|------|
| `01-step-type.md`, `02-step-variants.md` | `types/`, `builders/` | `steps/`, `api/step-types.mdx` |
| `03-control-flow.md` | `interpreter/execute-branch`, `execute-fork` | `operators/branch.mdx`, `operators/fork.mdx` |
| `04-spawn.md` | `interpreter/execute-spawn` | `operators/spawn.mdx` |
| `05-loop-and-until.md` | `until/`, `interpreter/execute-loop` | `operators/loop-and-until.mdx`, `api/until-types.mdx` |
| `06-channels.md` | `runtime/channel-store` | `operators/channels.mdx`, `api/channel-types.mdx` |
| `07-context-and-event-log.md` | `runtime/context-impl`, `runtime/item-log-impl` | `context.mdx`, `api/context-types.mdx` |
| `08-runtime.md` | `runtime/` | `runtime.mdx`, `api/runtime-types.mdx` |
| `09-error-model.md` | `errors/` | `errors.mdx` |
| `10-observability.md` | `observability/` | `observability.mdx` |
| `11-memory-layer-system.md`, `12-builtin-memory-layers.md` | `memory/` | `memory/`, `api/memory-types.mdx` |
| `13-patterns.md` | `patterns/` | `patterns/` |
| `16-semantic-conditions.md` | `conditions/`, `adapters/` | `operators/conditions.mdx`, `api/adapter-types.mdx` |

**Paths are relative to**: Specs → `specs/`, Source → `packages/core/src/`, Docs → `packages/web/content/docs/`
