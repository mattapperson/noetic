/**
 * Re-export shim. The FlowSchema definition lives in `@noetic-tools/core/patterns/flow`
 * so the plan memory layer can validate `setPlanTree` inputs against it.
 */

export type {
  FlowNode,
  ForkFlowNode,
  LlmFlowNode,
  SequenceFlowNode,
  SpawnFlowNode,
  SubagentFlowNode,
} from '@noetic-tools/core';
export { FlowSchema, flowDepth, validateFlow, walkFlow } from '@noetic-tools/core';
