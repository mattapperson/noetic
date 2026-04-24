# Noetic UI Runtime Integration - Implementation Summary

## Files Created

### 1. `packages/ui/src/runtime/types.ts`
Type definitions for the runtime integration:
- `StepKind`, `ExecutionStatus` - Core enums for step types and execution states
- `ExecutionNode`, `ExecutionTrace`, `Run` - Data models for execution recording
- `Breakpoint`, `DebuggerConfig`, `DebuggerState` - Debug configuration interfaces
- `ServerMessage`, `ClientMessage` - WebSocket protocol types
- `TraceExporter`, `SerializableSpan` - Export format types

### 2. `packages/ui/src/runtime/exporter.ts`
`NoeticUITraceExporter` class implementing the `TraceExporter` interface:
- Receives span data from Noetic core and forwards to WebSocket server
- Configurable buffering with automatic flushing
- Auto-reconnection with exponential backoff
- Zero-overhead when UI server is unavailable
- Supports tree-shaking (only loaded when debugging enabled)

### 3. `packages/ui/src/runtime/debugger.ts`
`Debugger` class providing full debugging capabilities:
- Pause/resume execution control
- Breakpoint support with condition evaluation
- Step-by-step execution (step over, into, out)
- Execution trace recording with timeline events
- Context snapshots at each step
- Real-time event streaming via WebSocket

### 4. `packages/ui/src/runtime/hook.ts`
Execution hooks with zero production overhead:
- `HookManager` - Central hook registry
- `globalHookManager` - Singleton instance
- Conditional hook execution (checks debugger presence first)
- Helper functions: `onStepStart`, `onStepComplete`, `onStepError`, etc.
- `isDebuggingEnabled()` - Guard function for conditional debug logic

### 5. `packages/ui/src/runtime/debug-harness.ts`
`DebugAgentHarness` wrapper class:
- Wraps standard `AgentHarness` with debugging capabilities
- `createDebugHarness()` factory function
- Integrates with `NoeticUITraceExporter` for real-time streaming
- Delegates to debugger for pause/resume and breakpoints
- Maintains compatibility with standard AgentHarness API

### 6. `packages/ui/src/runtime/enable.ts`
`enableDevUI()` opt-in entry point:
- Single function to wire up tracing, exporter, and WebSocket connection
- Must be called before the first `AgentHarness.run()`
- Idempotent — second call warns and returns a no-op handle
- Returns `{ disable(): void }` for test teardown

### 7. `packages/ui/tsconfig.json`
TypeScript configuration for the UI package.

## Key Design Decisions

### 1. Tree-Shaking Compatibility
All debug functionality is designed to be tree-shaken when not used:
```typescript
import { enableDevUI } from '@noetic/ui/runtime/enable';

if (process.env.NOETIC_UI_ENABLED === 'true') {
  enableDevUI();
}
```

### 2. Zero Production Overhead
- Hook checks are simple boolean flags (nanosecond cost)
- No additional memory allocation when disabled
- WebSocket and storage layers not loaded unless enabled
- Breakpoint engine completely bypassed in production

### 3. Conditional Hook Registration
Hooks check for debugger presence before executing:
```typescript
if (ctx.harness.debugger?.isAttached) {
  ctx.harness.debugger.onStepStart(step, input, ctx);
}
```

### 4. Type Safety
- Full TypeScript support with proper type guards
- Uses `satisfies` operator for type validation
- Discriminated unions for message types
- No unsafe type casting

### 5. WebSocket Protocol
Implements the server message protocol from spec 21-noetic-ui:
- `execution.start`, `execution.complete`, `execution.error`
- `node.start`, `node.complete`, `node.error`, `node.pause`, `node.resume`
- Auto-reconnection with exponential backoff
- Message queuing during disconnection

### 6. Breakpoint Conditions
Supports simple conditional breakpoints:
```typescript
{
  breakpoints: [
    { stepId: 'validate-step', condition: 'input.attempt > 3' }
  ]
}
```

## Integration Points

### With Noetic Core
- Implements `TraceExporter` interface from `@noetic/core`
- Uses `Span` and `Step` types from core
- Integrates with `AgentHarness` class

### With UI Server
- WebSocket connection to port 3333 (configurable)
- Sends `ServerMessage` protocol messages
- Supports real-time streaming and control commands

### With User Code
```typescript
import { enableDevUI } from '@noetic/ui/runtime/enable';

// Enable dev UI before running agents
if (process.env.NOETIC_UI_ENABLED === 'true') {
  enableDevUI({ port: 3333, agentName: 'my-agent' });
}
```

## Testing
The runtime files are TypeScript-compliant and follow the project lint rules. When the UI package dependencies are installed:
- `@noetic/core` - Core types and interfaces
- `ws` - WebSocket client
- `zod` - Runtime validation (already a dependency)

All files use proper type guards, avoid unsafe casting, and follow the codebase conventions.
