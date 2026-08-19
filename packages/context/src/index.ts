/**
 * @noetic-tools/context — the context layer system for Noetic agents: the
 * ContextLayer contract, lifecycle/budget/projection machinery, and built-in
 * layer implementations.
 */

// The execution-scope vocabulary (scope/outcome, model-call request) also lives
// in @noetic-tools/types but is part of the context-authoring surface.
export type {
  ContextScope,
  ExecutionContext,
  ExecutionOutcome,
  LayerCallModelRequest,
} from '@noetic-tools/types';
// The ContextLayer contract is foundational (referenced by Context/Step/runtime
// types), so it physically lives in @noetic-tools/types. Re-export it here so
// @noetic-tools/context remains the one-stop import for context-layer authoring.
export * from '@noetic-tools/types/contract';
export * from './context/budget';
export * from './context/cache-anchoring';
export * from './context/exec-context-factory';
export * from './context/function-call-utils';
export * from './context/layer-api';
export * from './context/layer-lifecycle';
export * from './context/layer-provides';
export * from './context/layer-usage';
export * from './context/layers/filesystem';
export * from './context/layers/history';
export * from './context/layers/instructions';
export * from './context/layers/observations';
export * from './context/layers/plan';
export * from './context/layers/scratchpad';
export * from './context/layers/steering';
export * from './context/layers/task-state';
export * from './context/layers/temporal';
export * from './context/layers/tool-calls';
export * from './context/projector';
export * from './context/scope';
export * from './context/storage-batch';
export * from './context/strip-unresolved';
