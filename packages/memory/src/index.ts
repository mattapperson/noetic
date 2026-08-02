/**
 * @noetic-tools/memory — DEPRECATED.
 *
 * The memory layer system was renamed to the **context layer** system: these
 * layers assemble the model's context window (recall, budget allocation,
 * history projection, the item-append pipeline), which is what they are for.
 *
 * This package is now a thin re-export of
 * [`@noetic-tools/context`](https://www.npmjs.com/package/@noetic-tools/context)
 * and receives no further changes. Every name — including the pre-rename ones
 * such as `MemoryLayer` and `workingMemory`, which survive as deprecated
 * aliases — resolves identically through either package.
 *
 * Migrate by changing the import specifier:
 *
 * ```ts
 * - import { workingMemory } from '@noetic-tools/memory';
 * + import { workingMemoryContext } from '@noetic-tools/context';
 * ```
 *
 * @deprecated Use `@noetic-tools/context`.
 */
export * from '@noetic-tools/context';
