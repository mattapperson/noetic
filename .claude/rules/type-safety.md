# Type Safety Rules

**CRITICAL:** These rules MUST be followed for ALL code changes.
They are mandatory, not optional.

## Core Rules

1. **Never use `any`** - Use `unknown` when type is not known
2. **Use `never`** - For functions that should not return
3. **Use `void`** - For functions returning `undefined`
4. **Minimal interfaces** - Only include required fields, don't speculate
5. **Static return types** - Always declare return types on functions
6. **ESM literal enums** - Prefer literal enums over TypeScript native enums
7. **Zod schemas** - Use for all API interfaces and runtime validation
8. **Use `satisfies`** - Instead of `as` type casting (retains literal type)
9. **Static strings** - Never type as `string`, use literal types
10. **No speculative type guards** - See below

## No Speculative Type Guards

**NEVER** add manual type guards unless TypeScript actually complains.

Before writing `'prop' in obj` or similar guards, **always check the types
first** using LSP hover or go-to-definition. Many libraries already define
optional properties as `T | undefined`.

```typescript
// BAD: Speculative guard when types already handle it
const channel = 'channel' in event ? event.channel : undefined;

// GOOD: Trust the types - just access directly
const channel = event.channel; // Already typed as string | undefined
```

**Process:**

1. Hover over the symbol to see its type
2. If prop exists (even as optional), access it directly
3. Only add guards when tsc reports "Property does not exist on type"

## Enums

Always use ESM literal enums, NOT TypeScript enums:

```ts
const Color = {
  Blue: 'blue',
  Green: 'green',
} as const;

type Color = (typeof Color)[keyof typeof Color];
```

## Numbers

- Use scientific notation: `1e3` instead of `1000`
- Always verify a variable is `number` before arithmetic

## ESM vs CJS

- Prefer ESM (ECMAScript Modules)
- For CJS-only libraries: `import * as lib from 'lib'`

## Adding Dependencies

- Freeze version on new dependencies
- Check size via [Bundlephobia](https://bundlephobia.com/)
- Extract only needed functions if package is large
- Include attribution URL when extracting code

## Complex Code Attribution

- Include URL for StackOverflow/online sources
- For AI-generated code: include model + prompt for reproducibility
