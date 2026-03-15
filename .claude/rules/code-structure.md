# Code Structure Rules

**CRITICAL:** These rules MUST be followed for ALL code changes.
They are mandatory, not optional.

## 1. Eliminate Nested Conditions with Early Returns

**ALWAYS** use early returns (guard clauses) instead of nested if statements:

```typescript
// BAD: Nested conditions
function process(input) {
  if (input) {
    if (input.valid) {
      if (input.ready) {
        // actual logic deeply nested
      }
    }
  }
}

// GOOD: Early returns
function process(input) {
  if (!input) {
    return;
  }
  if (!input.valid) {
    return;
  }
  if (!input.ready) {
    return;
  }
  // actual logic at top level
}
```

## 2. Replace Large Switch/If-Chains with Handler Registries

When you have more than 3-4 cases in a switch or if-chain, use a handler registry:

```typescript
// BAD: Long if-chain
function handleCommand(cmd) {
  if (cmd === 'a') {
    /* 10 lines */
  }
  else if (cmd === 'b') {
    /* 10 lines */
  }
  else if (cmd === 'c') {
    /* 10 lines */
  }
  // ... many more cases
}

// GOOD: Handler registry
type Handler = (context: Context) => void;

const handlers: Record<string, Handler> = {
  'a': handleA,
  'b': handleB,
  'c': handleC,
};

function handleCommand(cmd, context) {
  const handler = handlers[cmd];
  if (!handler) {
    return defaultResult;
  }
  return handler(context);
}
```

## 3. Extract Repeated Logic into Helper Functions

If you see the same pattern more than twice, extract it.

## 4. Keep Functions Small and Single-Purpose

- Each function should do ONE thing
- Handler functions should be 5-20 lines, not 50+
- If a function has multiple responsibilities, split it
- Name functions by what they DO: `handleSetModel`, `extractActionContext`, `buildStreamInput`

## 5. Use Context Objects for Related Parameters

```typescript
// BAD: Many parameters
function process(client, channel, messageTs, store, userId, tools) { }

// GOOD: Context object
interface ProcessContext {
  client: Client;
  channel: string;
  messageTs: string;
  store: Store;
}
function process(ctx: ProcessContext, userId: string, tools: Tool[]) { }
```

## 6. Organize File Structure Consistently

Use `#region` comments to organize code sections. IDEs like VS Code support
folding these regions.

```typescript
// 1. Imports (types first, then implementations)
import type { ... } from '...';

import { ... } from '...';

//#region Types

interface Context { ... }
type Handler = (...) => void;

//#endregion

//#region Helper Functions

function helperA() { ... }

//#endregion

//#region Handler Registry

const handlers: Record<string, Handler> = { ... };

//#endregion

//#region Public API

export function mainFunction() { ... }

//#endregion
```

## 7. Use `continue` and `return` to Flatten Loops

```typescript
// BAD: Nested event handling
for await (const event of stream) {
  if (event.type === 'a') {
    // handle a
  } else if (event.type === 'b') {
    // handle b
  } else {
    // handle default
  }
}

// GOOD: Early continue/return
for await (const event of stream) {
  if (event.type === 'a') {
    yield handleA(event);
    continue;
  }
  if (event.type === 'b') {
    yield handleB(event);
    continue;
  }
  yield handleDefault(event);
}
```

## 8. Extract Complex Case Handlers

```typescript
// BAD: Large inline case
case 'response.completed': {
  // 50 lines of logic
  break;
}

// GOOD: Extract to function
case 'response.completed':
  yield* handleResponseCompleted(event.response, trace, startTime);
  return;
```

## 9. Type Helper Functions Explicitly

```typescript
// Define handler types at top of file
type CommandHandler = (context: Context, content: string) => void;
type EventHandler = (event: Event, ctx: HandlerContext) => Promise<void>;

// Use in registries for type safety
const handlers: Record<string, CommandHandler> = { ... };
```

## 10. Always Run Checks After Changes

1. **Typecheck first**: Ensure `bun run typecheck` passes
2. **Stylecheck**: Ensure `bunx biome check .` passes
3. **Check structure**: Early returns, handler registries, function size
4. **Validate naming**: Correct case, boolean prefixes, plural arrays
5. **Validation**: External data parsed with Zod
6. **Tests**: Tests in `test/` directory, using `bun test`
7. **Modularity**: Domain-based structure, small files
