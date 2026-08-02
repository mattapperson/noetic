# @noetic-tools/memory

> **Deprecated — renamed to [`@noetic-tools/context`](https://www.npmjs.com/package/@noetic-tools/context).**

The memory layer system was renamed to the **context layer** system. These
layers assemble the model's context window — recall, budget allocation, history
projection, the item-append pipeline, steering — which is what they are for;
"memory" only ever described what a few of them happened to store.

This package is now a thin re-export of `@noetic-tools/context` and receives no
further changes. Everything resolves identically through either package, so
nothing breaks by staying here — but new code should not.

## Migrating

Change the import specifier:

```diff
- import { workingMemory, type MemoryLayer } from '@noetic-tools/memory';
+ import { workingMemoryContext, type ContextLayer } from '@noetic-tools/context';
```

The old names (`MemoryLayer`, `workingMemory`, `planMemory`, …) survive as
deprecated aliases in `@noetic-tools/context` too, so the specifier change alone
is a valid first step.

Most applications never import this package directly —
[`@noetic-tools/core`](https://www.npmjs.com/package/@noetic-tools/core)
re-exports the whole surface.

## License

Apache-2.0
