/**
 * Zod schema for plan-mode flow JSON.
 *
 * A "flow" is a JSON-serialisable subset of noetic's `Step` shape that the model
 * may emit during plan mode. The runtime expands each node into a concrete `Step`
 * via the existing builders (`step.llm`, `fork`, `spawn`) at execute time.
 *
 * Tool references inside `llm` nodes are name strings — they get resolved against
 * the harness's live tool registry when the flow runs.
 */

import { z } from 'zod';

//#region Types (declared first so the schema definitions can reference them)

interface NodeBase {
  id: string;
  subPlanRef?: string;
}

export interface LlmFlowNode extends NodeBase {
  kind: 'llm';
  model?: string;
  instructions: string;
  tools?: string[];
}

export interface SubagentFlowNode extends NodeBase {
  kind: 'subagent';
  preset: string;
  prompt: string;
}

export interface ForkFlowNode extends NodeBase {
  kind: 'fork';
  mode: 'all' | 'race' | 'settle';
  paths: FlowNode[];
}

export interface SpawnFlowNode extends NodeBase {
  kind: 'spawn';
  child: FlowNode;
}

export interface SequenceFlowNode extends NodeBase {
  kind: 'sequence';
  steps: FlowNode[];
}

export type FlowNode =
  | LlmFlowNode
  | SubagentFlowNode
  | ForkFlowNode
  | SpawnFlowNode
  | SequenceFlowNode;

//#endregion

//#region Schema

const FlowNodeRef: z.ZodType<FlowNode> = z.lazy(() => FlowNodeSchema);

const SHARED_FIELDS = {
  id: z.string().min(1),
  subPlanRef: z.string().optional(),
} as const;

const LlmNodeSchema = z.object({
  kind: z.literal('llm'),
  ...SHARED_FIELDS,
  model: z.string().optional(),
  instructions: z.string(),
  tools: z.array(z.string()).optional(),
});

const SubagentNodeSchema = z.object({
  kind: z.literal('subagent'),
  ...SHARED_FIELDS,
  preset: z.string().min(1),
  prompt: z.string(),
});

const ForkNodeSchema = z.object({
  kind: z.literal('fork'),
  ...SHARED_FIELDS,
  mode: z.enum([
    'all',
    'race',
    'settle',
  ]),
  paths: z.array(FlowNodeRef).min(1),
});

const SpawnNodeSchema = z.object({
  kind: z.literal('spawn'),
  ...SHARED_FIELDS,
  child: FlowNodeRef,
});

const SequenceNodeSchema = z.object({
  kind: z.literal('sequence'),
  ...SHARED_FIELDS,
  steps: z.array(FlowNodeRef).min(1),
});

const FlowNodeSchema: z.ZodType<FlowNode> = z.discriminatedUnion('kind', [
  LlmNodeSchema,
  SubagentNodeSchema,
  ForkNodeSchema,
  SpawnNodeSchema,
  SequenceNodeSchema,
]);

/** Top-level flow document — a single root node. */
export const FlowSchema = FlowNodeSchema;

//#endregion

//#region Public API

/** Validates a candidate flow document. Throws `ZodError` on invalid input. */
export function validateFlow(input: unknown): FlowNode {
  return FlowSchema.parse(input);
}

/** Walks a flow tree depth-first, yielding each node. */
export function* walkFlow(root: FlowNode): Iterable<FlowNode> {
  yield root;
  if (root.kind === 'fork') {
    for (const path of root.paths) {
      yield* walkFlow(path);
    }
    return;
  }
  if (root.kind === 'sequence') {
    for (const step of root.steps) {
      yield* walkFlow(step);
    }
    return;
  }
  if (root.kind === 'spawn') {
    yield* walkFlow(root.child);
    return;
  }
}

/**
 * Returns the maximum depth of a flow tree. A leaf (llm/subagent) is depth 0.
 * Structural nodes (sequence/fork/spawn) contribute +1 over their deepest child.
 */
export function flowDepth(node: FlowNode): number {
  if (node.kind === 'sequence') {
    return 1 + Math.max(0, ...node.steps.map(flowDepth));
  }
  if (node.kind === 'fork') {
    return 1 + Math.max(0, ...node.paths.map(flowDepth));
  }
  if (node.kind === 'spawn') {
    return 1 + flowDepth(node.child);
  }
  return 0;
}

//#endregion
