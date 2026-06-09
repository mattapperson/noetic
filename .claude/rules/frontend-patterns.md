# Frontend Patterns

Rules for React/TypeScript frontend code to prevent common runtime errors and follow best practices.

## React Imports

**CRITICAL:** React must be imported as a value, not just a type, when using JSX.

```typescript
// ❌ WRONG - Only imports types, breaks at runtime
import type React from 'react';

// ✅ CORRECT - Imports runtime value needed for JSX
import React from 'react';

// ✅ ALSO CORRECT - When only using types
import type { FC, ReactNode } from 'react';
```

**Checklist:**
- [ ] First import line uses `import React`, not `import type React`
- [ ] Component files with JSX have React imported as value
- [ ] Utility files only using types can use `import type`

## Unused Parameters

**CRITICAL:** Never prefix parameters with underscore (`_`) if they are actually used in the function.

```typescript
// ❌ WRONG - Parameter marked as unused but actually referenced
function processUser(_name: string, _id: string): User {
  return { 
    name: _name,  // ERROR: _name is referenced but marked unused
    id: _id,     // ERROR: _id is referenced but marked unused
  };
}

// ✅ CORRECT - Remove underscores if parameter is used
function processUser(name: string, id: string): User {
  return { name, id };
}

// ✅ CORRECT - Keep underscore only if truly unused
function processUser(name: string, _unused: string): User {
  return { name };
}
```

**Checklist:**
- [ ] No `_prefixed` parameters are referenced in the function body
- [ ] Remove underscore prefix if parameter is used
- [ ] Add underscore prefix only for truly unused parameters

## Import Validation

**CRITICAL:** Never use imports that don't exist or aren't imported.

```typescript
// ❌ WRONG - Using store that was never imported
const App = () => {
  const { data } = useDataStore();  // ERROR: useDataStore not imported!
  return <div>{data}</div>;
};

// ✅ CORRECT - Import before using
import { useDataStore } from './stores/data';

const App = () => {
  const { data } = useDataStore();
  return <div>{data}</div>;
};

// ✅ ALSO CORRECT - Comment out if not yet implemented
const App = () => {
  // TODO: Implement data store
  // const { data } = useDataStore();
  return <div>Loading...</div>;
};
```

**Checklist:**
- [ ] All used hooks/components are imported at top of file
- [ ] No references to undefined variables
- [ ] TODO comments added for planned but unimplemented features

## Type Casting vs Type Guards

**PREFER** type guards and Zod schemas over `as` type assertions.

```typescript
// ❌ AVOID - Type assertion without validation
function isUser(value: unknown): value is User {
  const user = value as User;  // Unsafe cast
  return user.id !== undefined;
}

// ✅ CORRECT - Use Zod for runtime validation
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
});

function isUser(value: unknown): value is User {
  return UserSchema.safeParse(value).success;
}

// ✅ ALSO CORRECT - Type guard with property checking
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as Record<string, unknown>).code === 'string'
  );
}
```

**Checklist:**
- [ ] Validate data with Zod schemas at runtime boundaries
- [ ] Use proper type guards instead of blind `as` casts
- [ ] Only use `as` when absolutely necessary with explanatory comments

## dangerouslySetInnerHTML

**AVOID** using `dangerouslySetInnerHTML`. If you must use it:

```typescript
// ❌ AVOID - Direct HTML string injection
<div dangerouslySetInnerHTML={{ __html: htmlString }} />

// ✅ CORRECT - Parse to React elements
function parseHtmlToReact(html: string): React.ReactNode {
  // Parse and return React elements instead of raw HTML
  return <span>parsed content</span>;
}
```

**Checklist:**
- [ ] Content is properly escaped/sanitized
- [ ] No user input is directly injected
- [ ] Consider safer alternatives first

## Keyboard Event Listeners

When adding window event listeners, ensure proper cleanup:

```typescript
// ❌ WRONG - Potential memory leak with stale closure
useEffect(() => {
  const handler = () => { /* uses state */ };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, []);  // Empty deps = stale closure!

// ✅ CORRECT - Include state dependencies
useEffect(() => {
  const handler = () => { /* uses state */ };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [state]);  // Include all dependencies
```

**Checklist:**
- [ ] Event listeners are properly cleaned up
- [ ] Dependency array includes all referenced state
- [ ] Use Zustand subscriptions for global state instead of window events

## Pre-Commit Verification

Before submitting code:

1. **Run the linter:**
   ```bash
   bun run lint
   ```

2. **Check for React import issues:**
   ```bash
   grep -r "import type React" packages/ui/src/client
   ```
   Should return no results.

3. **Check for underscore parameter issues:**
   ```bash
   grep -n "function.*_.*:" packages/ui/src --include="*.ts" --include="*.tsx"
   ```
   Review each result to ensure `_` params aren't used.

4. **Verify no missing imports:**
   Look for "Cannot find name" errors in your editor or CI.

## CI Will Catch

These issues will cause CI failures:

- React imported as type only
- Undefined variable references  
- Unused underscore parameters that are referenced
- Missing imports
- Type assertions without Zod schemas
- Keyboard shortcut memory leaks

**Fix them locally before pushing to avoid CI failures.**
