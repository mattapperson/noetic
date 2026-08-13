# Spec ↔ Code ↔ Docs ↔ Skill Sync

**CRITICAL:** These rules MUST be followed for ALL code changes.
They are mandatory, not optional.

## Requirements

1. **Code ↔ Spec**: When changing runtime code, update the corresponding spec if behavior diverges. When a spec changes, update the implementation to match.
2. **Code → Docs**: When code changes alter public API surface, behavior, or configuration, update the corresponding doc pages.
3. **Spec → Docs**: When a spec is added or revised, ensure the docs reflect the new specification.
4. **Code → Skill (agent-builder)**: When public API surface changes (new builders, patterns, context layers, tool APIs, or runtime methods), update the `noetic-agent-builder` skill at `.claude/skills/noetic-agent-builder/`. Update `references/api-reference.md` for API changes and `references/composition-patterns.md` for new patterns or usage examples.
5. **Code → Skill (eval)**: When `@noetic-tools/core` or `@noetic-tools/eval` changes affect the eval framework (scorers, runner, optimization, CLI, adapters, regression), update the `noetic-eval` skill at `.claude/skills/noetic-eval/`. Update `SKILL.md` for workflow/concept changes and `references/api-reference.md` for API signature changes.
6. **Code → JSON Schema**: When changing the JSON-workflow Zod schema in `packages/core/src/schemas/workflow.ts` (the `WorkflowDocumentSchema`, any `WorkflowNode` variant, the `UntilPredicate` union, merge strategies, or model params), you MUST run `bun run gen:schema` (from `packages/core`) and commit the regenerated artifacts **in the same commit**. That one command rewrites both published copies from the Zod source — the package artifact `packages/core/schema/noetic-workflow.schema.json` and the hosted copy `packages/web/public/schema/noetic-workflow.schema.json` (served at the schema's `$id`, `https://noetic.tools/schema/noetic-workflow.schema.json`). Never hand-edit the generated `*.schema.json` files — change the Zod schema and regenerate. The drift-gate test (`packages/core/test/schemas/workflow-json-schema.test.ts`) fails CI if either copy is stale.

## Reference Mapping

| Spec | Source | Docs |
|------|--------|------|
| `01-step-type.md`, `02-step-variants.md` | `types/`, `builders/` | `steps/`, `api/step-types.mdx` |
| `03-control-flow.md` | `interpreter/execute-branch`, `execute-fork` | `operators/conditional.mdx`, `operators/in-parallel.mdx` |
| `04-spawn.md` | `interpreter/execute-spawn` | `operators/spawn.mdx` |
| `05-loop-and-until.md` | `until/`, `interpreter/execute-loop` | `operators/loop-and-until.mdx`, `api/until-types.mdx` |
| `06-channels.md` | `runtime/channel-store` | `operators/channels.mdx`, `api/channel-types.mdx` |
| `07-context-and-event-log.md` | `runtime/context-impl`, `runtime/item-log-impl` | `context.mdx`, `api/context-types.mdx` |
| `08-runtime.md` (AgentHarness) | `runtime/` | `runtime.mdx`, `api/runtime-types.mdx` |
| `09-error-model.md` | `errors/` | `errors.mdx` |
| `10-observability.md` | `observability/` | `observability.mdx` |
| `11-context-layer-system.md`, `12-builtin-context-layers.md` | `packages/context/src/` (`ContextLayer` contract in `packages/types/src/types/context-layer.ts`) | `context-layers/`, `api/context-layer-types.mdx` |
| (foundation types) | `packages/types/src/` | `api/` |
| `13-patterns.md` | `runtime/durable/`, `packages/core/examples/` | (public pattern docs removed — only `framework/json-runtime.mdx` documents `dynamicWorkflow`/`parseAndRunWorkflow`) |
| `16-semantic-conditions.md` | `conditions/`, `adapters/` | `operators/conditions.mdx`, `api/adapter-types.mdx` |
| `17-eval-and-optimization.md` | `packages/eval/src/` | (eval docs TBD) |
| `12a-cli-context-layers.md`, `21-tasks.md`, `22-cli-architecture.md` | (none — the CLI is implemented in the separate `noetic-internal` repo; these specs stay here as its contract, so there is no in-repo source to keep in sync) | `code-agent-cli/` |
| `25-platform-packages.md` | `packages/platform-node/src/`, `packages/platform-browser/src/` | `framework/platform-packages.mdx` |
| `26-json-workflow-runtime.md` | `schemas/workflow.ts`, `builders/workflow-hydrator.ts`, `builders/dynamic-workflow.ts` | `framework/json-runtime.mdx` (+ run `bun run gen:schema`, see Requirement 6) |
| `27-acp-agent-steps.md` | `packages/types/src/types/acp.ts`, `interpreter/execute-acp-agent`, `interpreter/acp-events`, `builders/step-builders` (`step.acpAgent`), `packages/acp/src/` | `framework/acp-agents.mdx` |
| `28-generative-ui.md` | `packages/types/src/types/output-codec.ts`, `packages/types/src/types/tool.ts` (`UiFragment`, `ToolUiDeclaration`), `packages/openui/src/` | `framework/generative-ui.mdx` |
| `29-chat-platform-integration.md` | `packages/chat-sdk/src/`, `packages/core/src/runtime/channel-store.ts` (`getChannelStream`) | `framework/chat-sdk.mdx` |

**Paths are relative to**: Specs → `specs/`, Source → `packages/core/src/` (except rows that name a full `packages/...` path), Docs → `packages/web/content/docs/`

## Skill Mapping

| Source Area | Skill File |
|-------------|------------|
| `builders/`, `types/`, `packages/context/src/context/layers/` | `.claude/skills/noetic-agent-builder/references/api-reference.md` |
| `runtime/durable/`, `examples/` | `.claude/skills/noetic-agent-builder/references/composition-patterns.md` |
| Any public API change | `.claude/skills/noetic-agent-builder/SKILL.md` (if core concepts change) |
| `packages/eval/src/runner/`, `packages/eval/src/scorers/` | `.claude/skills/noetic-eval/references/api-reference.md` |
| `packages/eval/src/optimization/`, `packages/eval/src/cli/` | `.claude/skills/noetic-eval/references/api-reference.md` |
| `packages/eval/src/adapters/`, `packages/eval/src/regression/` | `.claude/skills/noetic-eval/references/api-reference.md` |
| Any eval public API or workflow change | `.claude/skills/noetic-eval/SKILL.md` |
