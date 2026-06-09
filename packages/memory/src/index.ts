/**
 * @noetic-tools/memory — the memory layer system for Noetic agents: the
 * MemoryLayer contract, lifecycle/budget/projection machinery, and built-in
 * layer implementations.
 */

// The memory-context vocabulary (execution scope/outcome, model-call request)
// also lives in @noetic-tools/types but is part of the memory authoring surface.
export type {
  ExecutionContext,
  ExecutionOutcome,
  MemoryCallModelRequest,
  MemoryScope,
} from '@noetic-tools/types';
// The MemoryLayer contract is foundational (referenced by Context/Step/runtime
// types), so it physically lives in @noetic-tools/types. Re-export it here so
// @noetic-tools/memory remains the one-stop import for memory-layer authoring.
export * from '@noetic-tools/types/contract';
export * from './memory/budget';
export * from './memory/exec-context-factory';
export * from './memory/flow-schema';
export * from './memory/function-call-utils';
export * from './memory/layer-api';
export * from './memory/layer-lifecycle';
export * from './memory/layer-provides';
export * from './memory/layer-usage';
export * from './memory/layers/durable-task-state';
export * from './memory/layers/file-reference';
export * from './memory/layers/history-window';
export * from './memory/layers/observational-memory';
export * from './memory/layers/plan';
export * from './memory/layers/static-content';
export * from './memory/layers/steering';
export * from './memory/layers/temporal';
export * from './memory/layers/tool-memory-layer';
export * from './memory/layers/working-memory';
export * from './memory/projector';
export * from './memory/scope';
export * from './memory/strip-unresolved';
