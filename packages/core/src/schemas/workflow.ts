/**
 * Zod schemas for JSON-serialisable workflow definitions.
 *
 * A `WorkflowDocument` is a portable, JSON-safe representation of a noetic
 * step tree. It covers every step kind except `run` (which carries arbitrary
 * closures). The hydrator in `builders/workflow-hydrator.ts` converts a
 * validated document back into live `Step` objects via the existing builders.
 */

import { z } from 'zod';

//#region Until Predicate Types

interface UntilAnyPredicate {
  kind: 'any';
  predicates: UntilPredicate[];
}

interface UntilAllPredicate {
  kind: 'all';
  predicates: UntilPredicate[];
}

/** @public Discriminated union of named until predicates usable in JSON workflows. */
export type UntilPredicate =
  | {
      kind: 'maxSteps';
      n: number;
    }
  | {
      kind: 'maxCost';
      usd: number;
    }
  | {
      kind: 'maxDuration';
      ms: number;
    }
  | {
      kind: 'noToolCalls';
    }
  | {
      kind: 'outputContains';
      marker: string;
    }
  | {
      kind: 'outputEquals';
      sentinel: string;
    }
  | {
      kind: 'converged';
      threshold?: number;
    }
  | UntilAnyPredicate
  | UntilAllPredicate;

//#endregion

//#region Until Predicate Schemas

const MaxStepsPredicateSchema = z.object({
  kind: z.literal('maxSteps'),
  n: z.number().int().positive(),
});

const MaxCostPredicateSchema = z.object({
  kind: z.literal('maxCost'),
  usd: z.number().positive(),
});

const MaxDurationPredicateSchema = z.object({
  kind: z.literal('maxDuration'),
  ms: z.number().positive(),
});

const NoToolCallsPredicateSchema = z.object({
  kind: z.literal('noToolCalls'),
});

const OutputContainsPredicateSchema = z.object({
  kind: z.literal('outputContains'),
  marker: z.string().min(1),
});

const OutputEqualsPredicateSchema = z.object({
  kind: z.literal('outputEquals'),
  sentinel: z.string().min(1),
});

const ConvergedPredicateSchema = z.object({
  kind: z.literal('converged'),
  threshold: z.number().min(0).max(1).optional(),
});

const UntilPredicateRef: z.ZodType<UntilPredicate> = z.lazy(() => UntilPredicateSchema);

const AnyPredicateSchema = z.object({
  kind: z.literal('any'),
  predicates: z.array(UntilPredicateRef).min(1),
});

const AllPredicateSchema = z.object({
  kind: z.literal('all'),
  predicates: z.array(UntilPredicateRef).min(1),
});

/** @public Zod schema validating a named `until` predicate (including `any`/`all` combinators). */
export const UntilPredicateSchema: z.ZodType<UntilPredicate> = z
  .union([
    MaxStepsPredicateSchema,
    MaxCostPredicateSchema,
    MaxDurationPredicateSchema,
    NoToolCallsPredicateSchema,
    OutputContainsPredicateSchema,
    OutputEqualsPredicateSchema,
    ConvergedPredicateSchema,
    AnyPredicateSchema,
    AllPredicateSchema,
  ])
  .meta({
    id: 'UntilPredicate',
    title: 'UntilPredicate',
  });

//#endregion

//#region Merge Strategy

/** @public ESM literal enum for merge strategies. */
export const MergeStrategy = {
  Last: 'last',
  First: 'first',
  Concat: 'concat',
} as const;

/** @public Named merge strategy for fork nodes. */
export type MergeStrategy = (typeof MergeStrategy)[keyof typeof MergeStrategy];

/** @public Zod schema for the named merge strategy used by `fork` nodes. */
export const MergeStrategySchema = z.enum([
  'last',
  'first',
  'concat',
]);

//#endregion

//#region Model Params

const ModelParamsSchema = z.object({
  temperature: z.number().min(0).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  stopSequences: z.array(z.string()).optional(),
});

//#endregion

//#region Workflow Node Types

interface WorkflowNodeBase {
  id: string;
}

export interface LlmWorkflowNode extends WorkflowNodeBase {
  kind: 'llm';
  model?: string;
  instructions: string;
  tools?: string[];
  params?: z.infer<typeof ModelParamsSchema>;
}

export interface ToolWorkflowNode extends WorkflowNodeBase {
  kind: 'tool';
  toolName: string;
  args?: Record<string, unknown>;
}

export interface BranchRoute {
  match: string;
  target: WorkflowNode;
}

export interface BranchWorkflowNode extends WorkflowNodeBase {
  kind: 'branch';
  routes: BranchRoute[];
  default?: WorkflowNode;
}

export interface ForkWorkflowNode extends WorkflowNodeBase {
  kind: 'fork';
  mode: 'race' | 'all' | 'settle';
  paths: WorkflowNode[];
  merge?: MergeStrategy;
  concurrency?: number;
}

export interface SpawnWorkflowNode extends WorkflowNodeBase {
  kind: 'spawn';
  child: WorkflowNode;
  timeout?: number;
}

export interface ProvideWorkflowNode extends WorkflowNodeBase {
  kind: 'provide';
  child: WorkflowNode;
  layers: string[];
}

export interface LoopWorkflowNode extends WorkflowNodeBase {
  kind: 'loop';
  body: WorkflowNode;
  until: UntilPredicate;
  maxIterations?: number;
}

export interface SequenceWorkflowNode extends WorkflowNodeBase {
  kind: 'sequence';
  steps: WorkflowNode[];
}

export interface EveryWorkflowNode extends WorkflowNodeBase {
  kind: 'every';
  step: WorkflowNode;
  ms: number;
  onError?: 'continue' | 'fail';
}

/** @public Discriminated union of all JSON-serialisable workflow node kinds. */
export type WorkflowNode =
  | LlmWorkflowNode
  | ToolWorkflowNode
  | BranchWorkflowNode
  | ForkWorkflowNode
  | SpawnWorkflowNode
  | ProvideWorkflowNode
  | LoopWorkflowNode
  | SequenceWorkflowNode
  | EveryWorkflowNode;

//#endregion

//#region Workflow Node Schema

const WorkflowNodeRef: z.ZodType<WorkflowNode> = z.lazy(() => WorkflowNodeSchema);

const SHARED_FIELDS = {
  id: z.string().min(1),
} as const;

const LlmNodeSchema = z.object({
  kind: z.literal('llm'),
  ...SHARED_FIELDS,
  model: z.string().optional(),
  instructions: z.string(),
  tools: z.array(z.string()).optional(),
  params: ModelParamsSchema.optional(),
});

const ToolNodeSchema = z.object({
  kind: z.literal('tool'),
  ...SHARED_FIELDS,
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});

const BranchRouteSchema = z.object({
  match: z.string().min(1),
  target: z.lazy(() => WorkflowNodeSchema),
});

const BranchNodeSchema = z.object({
  kind: z.literal('branch'),
  ...SHARED_FIELDS,
  routes: z.array(BranchRouteSchema).min(1),
  default: WorkflowNodeRef.optional(),
});

const ForkNodeSchema = z.object({
  kind: z.literal('fork'),
  ...SHARED_FIELDS,
  mode: z.enum([
    'race',
    'all',
    'settle',
  ]),
  paths: z.array(WorkflowNodeRef).min(1),
  merge: MergeStrategySchema.optional(),
  concurrency: z.number().int().positive().optional(),
});

const SpawnNodeSchema = z.object({
  kind: z.literal('spawn'),
  ...SHARED_FIELDS,
  child: WorkflowNodeRef,
  timeout: z.number().positive().optional(),
});

const ProvideNodeSchema = z.object({
  kind: z.literal('provide'),
  ...SHARED_FIELDS,
  child: WorkflowNodeRef,
  layers: z.array(z.string().min(1)).min(1),
});

const LoopNodeSchema = z.object({
  kind: z.literal('loop'),
  ...SHARED_FIELDS,
  body: WorkflowNodeRef,
  until: UntilPredicateSchema,
  maxIterations: z.number().int().positive().optional(),
});

const SequenceNodeSchema = z.object({
  kind: z.literal('sequence'),
  ...SHARED_FIELDS,
  steps: z.array(WorkflowNodeRef).min(1),
});

const EveryNodeSchema = z.object({
  kind: z.literal('every'),
  ...SHARED_FIELDS,
  step: WorkflowNodeRef,
  ms: z.number().nonnegative(),
  onError: z
    .enum([
      'continue',
      'fail',
    ])
    .optional(),
});

/** @public Zod schema validating a single `WorkflowNode` (any of the 9 JSON-safe kinds). */
export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z
  .discriminatedUnion('kind', [
    LlmNodeSchema,
    ToolNodeSchema,
    BranchNodeSchema,
    ForkNodeSchema,
    SpawnNodeSchema,
    ProvideNodeSchema,
    LoopNodeSchema,
    SequenceNodeSchema,
    EveryNodeSchema,
  ])
  .meta({
    id: 'WorkflowNode',
    title: 'WorkflowNode',
  });

//#endregion

//#region Workflow Document

/** @public Top-level envelope for a JSON workflow definition. */
export interface WorkflowDocument {
  version: 1;
  root: WorkflowNode;
}

/** @public Zod schema validating a complete `WorkflowDocument`. */
export const WorkflowDocumentSchema: z.ZodType<WorkflowDocument> = z
  .object({
    version: z.literal(1),
    root: WorkflowNodeSchema,
  })
  .meta({
    id: 'WorkflowDocument',
    title: 'WorkflowDocument',
    description: 'A portable, JSON-safe representation of a Noetic step tree.',
  });

//#endregion

//#region Helpers

/** Returns the direct child nodes of a workflow node. Leaf nodes return an empty array. */
function childNodes(node: WorkflowNode): WorkflowNode[] {
  switch (node.kind) {
    case 'sequence':
      return node.steps;
    case 'fork':
      return node.paths;
    case 'spawn':
    case 'provide':
      return [
        node.child,
      ];
    case 'loop':
      return [
        node.body,
      ];
    case 'every':
      return [
        node.step,
      ];
    case 'branch': {
      const children = node.routes.map((r) => r.target);
      if (node.default) {
        children.push(node.default);
      }
      return children;
    }
    default:
      return [];
  }
}

/** Validates a candidate workflow document. Throws `ZodError` on invalid input. */
export function validateWorkflow(input: unknown): WorkflowDocument {
  return WorkflowDocumentSchema.parse(input);
}

/** Walks a workflow tree depth-first, yielding each node. */
export function* walkWorkflow(node: WorkflowNode): Iterable<WorkflowNode> {
  yield node;
  for (const child of childNodes(node)) {
    yield* walkWorkflow(child);
  }
}

/**
 * Returns the maximum depth of a workflow tree.
 * Leaf nodes (`llm`, `tool`) have depth 0. Structural nodes add +1.
 */
export function workflowDepth(node: WorkflowNode): number {
  const children = childNodes(node);
  if (children.length === 0) {
    return 0;
  }
  return 1 + Math.max(0, ...children.map(workflowDepth));
}

//#endregion
