/**
 * Deprecated aliases from the "memory layer" era of the framework.
 *
 * The layer system assembles the model's *context window* — recall, budget
 * allocation, history projection, the item-append pipeline — so it is named
 * after context, not memory. Every name below still resolves to its
 * replacement; nothing here changes behaviour.
 *
 * Most of these are plain pass-throughs: the alias and its replacement already
 * live in `@noetic-tools/types` / `@noetic-tools/context`, and re-exporting
 * carries each name's `@deprecated` pointer along with it. Only the renaming
 * aliases — where core exports a symbol under a *different* name than its
 * source package does — are declared here.
 *
 * The matching runtime aliases (the `memory:` config key on `provide`/`spawn`/
 * `tool`/`react`/`AgentHarness`, and the `ctx.memory` accessor) are handled at
 * their call sites — see `resolveContextOption`.
 *
 * Scheduled for removal in the next major of `@noetic-tools/core`.
 */

export type {
  ContextMemory,
  InferMemory,
  InferMemoryShape,
  MemoryCallModelRequest,
  MemoryConfig,
  MemoryHooks,
  MemoryLayer,
  MemoryScope,
  MemoryTraceSpan,
  ToolMemory,
  ToolMemoryDeclaration,
} from '@noetic-tools/types';
export {
  /**
   * @public
   * @deprecated Renamed to `context`. Declared here rather than re-exported
   * because the builder itself lives in core under its new name.
   */
  context as memory,
} from './builders/context-builder';
