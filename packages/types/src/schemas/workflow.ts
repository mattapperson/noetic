/**
 * Zod schemas for JSON-serialisable workflow definitions.
 *
 * A `WorkflowDocument` is a portable, JSON-safe representation of a noetic
 * step tree. It covers every step kind. The `runCode` node carries its body as
 * a code STRING (not an in-process closure) dispatched through a subprocess
 * adapter, keeping the document JSON-safe. The hydrator in
 * `@noetic-tools/core` (`builders/workflow-hydrator.ts`) converts a validated
 * document back into live `Step` objects via the existing builders.
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
      duration: number;
    }
  | {
      kind: 'noToolCalls';
    }
  | {
      kind: 'never';
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
  duration: z.number().positive(),
});

const NoToolCallsPredicateSchema = z.object({
  kind: z.literal('noToolCalls'),
});

const NeverPredicateSchema = z.object({
  kind: z.literal('never'),
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
    NeverPredicateSchema,
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

/** @public Named merge strategy for inParallel nodes. */
export type MergeStrategy = (typeof MergeStrategy)[keyof typeof MergeStrategy];

/** @public Zod schema for the named merge strategy used by `inParallel` nodes. */
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

//#region Tool Entries

/**
 * A uniform tool entry on a `callModel` node. Every entry is an object keyed by
 * `type`:
 *   - A CLIENT tool is `{ type: "<registered-tool-name>" }`. The hydrator
 *     resolves `type` against the tool registry; `parameters` (if present) is
 *     ignored — client tools receive their call args from the model at runtime.
 *   - A SERVER tool is `{ type: "openrouter:web_search" | "openrouter:web_fetch",
 *     parameters?: {...} }`. The provider executes it; `parameters` keys are
 *     camelCase (e.g. `maxResults`, `searchContextSize`) — the SDK re-serialises
 *     them and silently drops unknown keys.
 *
 * Server vs client is decided by the `type` value (a reserved `openrouter:*`
 * server-tool literal vs an arbitrary tool name), not by the entry's shape.
 */
const CallModelToolEntrySchema = z.object({
  type: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

//#endregion

//#region Retry Policy

/** Retry policy for a `runCode` node, mirroring `RetryPolicy` in `@noetic-tools/types`. */
const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive(),
  backoff: z.enum([
    'fixed',
    'linear',
    'exponential',
  ]),
  initialDelay: z.number().nonnegative(),
  maxDelay: z.number().nonnegative().optional(),
});

//#endregion

//#region ACP Agent Settings

/** ACP `ToolKind` — the agent's own classification of a tool call. */
const AcpToolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

const AcpPermissionDecisionSchema = z.enum([
  'allow',
  'deny',
  'cancel',
]);

/**
 * A permission rule. Both fields are optional matchers; an omitted field
 * matches anything. `title` is a case-insensitive substring match here — the
 * programmatic API additionally accepts a `RegExp`, which JSON cannot express.
 */
const AcpPermissionRuleSchema = z.object({
  kind: AcpToolKindSchema.optional(),
  title: z.string().min(1).optional(),
});

const AcpPermissionPolicySchema = z.object({
  default: AcpPermissionDecisionSchema.optional(),
  allow: z.array(AcpPermissionRuleSchema).optional(),
  deny: z.array(AcpPermissionRuleSchema).optional(),
  persist: z.boolean().optional(),
});

const AcpClientCapabilityConfigSchema = z.object({
  readTextFile: z.boolean().optional(),
  writeTextFile: z.boolean().optional(),
  terminal: z.boolean().optional(),
});

const AcpNamedValueSchema = z.object({
  name: z.string(),
  value: z.string(),
});

/** ACP `McpServer`. Stdio is untagged and mandatory for every agent; http/sse are capability-gated. */
const AcpMcpServerSchema = z.union([
  z.object({
    type: z.literal('http'),
    name: z.string().min(1),
    url: z.string(),
    headers: z.array(AcpNamedValueSchema),
  }),
  z.object({
    type: z.literal('sse'),
    name: z.string().min(1),
    url: z.string(),
    headers: z.array(AcpNamedValueSchema),
  }),
  z.object({
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.array(AcpNamedValueSchema),
  }),
]);

const AcpSessionPolicySchema = z.object({
  reuse: z.string().min(1).optional(),
  onComplete: z
    .enum([
      'close',
      'keep',
    ])
    .optional(),
  load: z.string().min(1).optional(),
});

//#endregion

//#region Workflow Node Types

interface WorkflowNodeBase {
  id: string;
}

/**
 * A reference to a streaming `OutputCodec` for a `callModel` node's structured
 * output. The hydrator resolves `library` from `HydrationContext.uiLibraries`
 * to a live codec (e.g. `openUi(myLibrary)` from `@noetic-tools/openui`), the
 * same registry-resolution pattern `acp-agent` nodes use for adapters. Kept a
 * *reference* because a codec is a runtime object, not JSON-expressible.
 */
export interface OutputCodecRef {
  /** The codec dialect. Only `'openui'` is defined today. */
  codec: 'openui';
  /** Registry key resolved from `HydrationContext.uiLibraries`. */
  library: string;
}

export interface CallModelWorkflowNode extends WorkflowNodeBase {
  kind: 'callModel';
  model?: string;
  instructions: string;
  /**
   * Tool entries. Every entry is an object `{ type, parameters? }`. A CLIENT
   * tool is `{ type: "<registered-tool-name>" }` (resolved from the registry);
   * a SERVER tool is `{ type: "openrouter:web_search" | "openrouter:web_fetch",
   * parameters?: {...} }` (executed by the provider). Client vs server is
   * decided by the `type` value.
   */
  tools?: z.infer<typeof CallModelToolEntrySchema>[];
  params?: z.infer<typeof ModelParamsSchema>;
  /** Streaming output-codec reference, resolved from `HydrationContext.uiLibraries`. */
  output?: OutputCodecRef;
}

export interface InvokeToolWorkflowNode extends WorkflowNodeBase {
  kind: 'invokeTool';
  toolName: string;
  args?: Record<string, unknown>;
}

/**
 * A node that runs a serialised code body. Unlike the programmatic
 * `step.runCode` (which carries a closure), the JSON form carries `execute` as
 * a code STRING.
 * The code is never eval'd in-process (Cloudflare Workers forbid eval); it is
 * dispatched through a subprocess adapter (`ctx.subprocess`, or a named adapter
 * resolved by ref). Execution therefore requires a subprocess adapter capable
 * of running the code and returning its stdout.
 */
export interface RunCodeWorkflowNode extends WorkflowNodeBase {
  kind: 'runCode';
  /** Source code executed in the subprocess. Receives the step input on stdin. */
  execute: string;
  /** Optional retry policy applied to the step. */
  retry?: z.infer<typeof RetryPolicySchema>;
  /** Named subprocess adapter ref; defaults to `ctx.subprocess` when omitted. */
  subprocess?: string;
}

export interface ConditionalRoute {
  match: string;
  target: WorkflowNode;
}

export interface ConditionalWorkflowNode extends WorkflowNodeBase {
  kind: 'conditional';
  routes: ConditionalRoute[];
  default?: WorkflowNode;
}

export interface InParallelWorkflowNode extends WorkflowNodeBase {
  kind: 'inParallel';
  mode: 'race' | 'all' | 'settle';
  /**
   * Static fan-out: one child per entry. Mutually exclusive with `each` —
   * supply exactly one.
   */
  paths?: WorkflowNode[];
  /**
   * Dynamic fan-out: instantiate this body template once per item of a
   * runtime-produced array (data-dependent N). Mutually exclusive with `paths`.
   */
  each?: WorkflowNode;
  /**
   * Selector key into the inParallel input (parsed as JSON) locating the array
   * to fan out over. When omitted, the input string itself is parsed as a JSON
   * array. Only meaningful with `each`.
   */
  over?: string;
  merge?: MergeStrategy;
  concurrency?: number;
}

export interface SpawnWorkflowNode extends WorkflowNodeBase {
  kind: 'spawn';
  child: WorkflowNode;
  timeout?: number;
  /**
   * Memory layers the child runs with, by registered name (resolved from
   * `HydrationContext.layers`, like `withContext`). Omit to inherit the
   * parent's layers — the default spawn behaviour. Naming layers here REPLACES
   * the inherited set for the child, so list every layer the child needs.
   */
  layers?: string[];
}

export interface WithContextWorkflowNode extends WorkflowNodeBase {
  kind: 'withContext';
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

export interface ScheduleWorkflowNode extends WorkflowNodeBase {
  kind: 'schedule';
  step: WorkflowNode;
  interval: number;
  onError?: 'continue' | 'fail';
}

/**
 * A node that delegates a turn to an external coding agent over the Agent
 * Client Protocol. `agent` is a registry key resolved from
 * `HydrationContext.acpAgents` — an OPEN set, so supporting a new agent never
 * changes this schema.
 */
export interface AcpAgentWorkflowNode extends WorkflowNodeBase {
  kind: 'acp-agent';
  /** Registry key for the ACP agent adapter (e.g. `claude-code`). */
  agent: string;
  prompt: string;
  /** Absolute working directory for the session. Defaults to the runtime cwd. */
  cwd?: string;
  /** Session mode to switch to before prompting. */
  mode?: string;
  /** Model to select before prompting. */
  model?: string;
  mcpServers?: z.infer<typeof AcpMcpServerSchema>[];
  permissions?: z.infer<typeof AcpPermissionPolicySchema>;
  clientCapabilities?: z.infer<typeof AcpClientCapabilityConfigSchema>;
  session?: z.infer<typeof AcpSessionPolicySchema>;
}

/**
 * A node that runs another workflow document as a sub-step. The document is
 * either inline or a named reference resolved from `HydrationContext.workflows`
 * at execution time. Supply exactly one of `document` / `ref`.
 */
export interface SubflowWorkflowNode extends WorkflowNodeBase {
  kind: 'subflow';
  /** Inline sub-workflow. Mutually exclusive with `ref`. */
  document?: WorkflowDocument;
  /** Named sub-workflow resolved from `HydrationContext.workflows`. Mutually exclusive with `document`. */
  ref?: string;
  /** Literal input passed to the sub-workflow; defaults to the node's runtime input. */
  input?: string;
}

/** @public Discriminated union of all JSON-serialisable workflow node kinds. */
export type WorkflowNode =
  | CallModelWorkflowNode
  | InvokeToolWorkflowNode
  | RunCodeWorkflowNode
  | ConditionalWorkflowNode
  | InParallelWorkflowNode
  | SpawnWorkflowNode
  | WithContextWorkflowNode
  | LoopWorkflowNode
  | SequenceWorkflowNode
  | ScheduleWorkflowNode
  | SubflowWorkflowNode
  | AcpAgentWorkflowNode;

//#endregion

//#region Workflow Node Schema

const WorkflowNodeRef: z.ZodType<WorkflowNode> = z.lazy(() => WorkflowNodeSchema);

const SHARED_FIELDS = {
  id: z.string().min(1),
} as const;

const OutputCodecRefSchema = z.object({
  codec: z.literal('openui'),
  library: z.string().min(1),
});

const CallModelNodeSchema = z.object({
  kind: z.literal('callModel'),
  ...SHARED_FIELDS,
  model: z.string().optional(),
  instructions: z.string(),
  tools: z.array(CallModelToolEntrySchema).optional(),
  params: ModelParamsSchema.optional(),
  output: OutputCodecRefSchema.optional(),
});

const InvokeToolNodeSchema = z.object({
  kind: z.literal('invokeTool'),
  ...SHARED_FIELDS,
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});

const RunCodeNodeSchema = z.object({
  kind: z.literal('runCode'),
  ...SHARED_FIELDS,
  execute: z.string().min(1),
  retry: RetryPolicySchema.optional(),
  subprocess: z.string().min(1).optional(),
});

const ConditionalRouteSchema = z.object({
  match: z.string().min(1),
  target: z.lazy(() => WorkflowNodeSchema),
});

const ConditionalNodeSchema = z.object({
  kind: z.literal('conditional'),
  ...SHARED_FIELDS,
  routes: z.array(ConditionalRouteSchema).min(1),
  default: WorkflowNodeRef.optional(),
});

const InParallelNodeSchema = z
  .object({
    kind: z.literal('inParallel'),
    ...SHARED_FIELDS,
    mode: z.enum([
      'race',
      'all',
      'settle',
    ]),
    paths: z.array(WorkflowNodeRef).min(1).optional(),
    each: WorkflowNodeRef.optional(),
    over: z.string().min(1).optional(),
    merge: MergeStrategySchema.optional(),
    concurrency: z.number().int().positive().optional(),
  })
  .refine((node) => (node.paths === undefined) !== (node.each === undefined), {
    message: "inParallel node requires exactly one of 'paths' (static) or 'each' (dynamic).",
  });

const SpawnNodeSchema = z.object({
  kind: z.literal('spawn'),
  ...SHARED_FIELDS,
  child: WorkflowNodeRef,
  timeout: z.number().positive().optional(),
  layers: z.array(z.string().min(1)).min(1).optional(),
});

const WithContextNodeSchema = z.object({
  kind: z.literal('withContext'),
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

const ScheduleNodeSchema = z.object({
  kind: z.literal('schedule'),
  ...SHARED_FIELDS,
  step: WorkflowNodeRef,
  interval: z.number().nonnegative(),
  onError: z
    .enum([
      'continue',
      'fail',
    ])
    .optional(),
});

const WorkflowDocumentRef: z.ZodType<WorkflowDocument> = z.lazy(() => WorkflowDocumentSchema);

const SubflowNodeSchema = z
  .object({
    kind: z.literal('subflow'),
    ...SHARED_FIELDS,
    document: WorkflowDocumentRef.optional(),
    ref: z.string().min(1).optional(),
    input: z.string().optional(),
  })
  .refine((node) => (node.document === undefined) !== (node.ref === undefined), {
    message: "subflow node requires exactly one of 'document' (inline) or 'ref' (named).",
  });

const AcpAgentNodeSchema = z.object({
  kind: z.literal('acp-agent'),
  ...SHARED_FIELDS,
  agent: z.string().min(1),
  prompt: z.string().min(1),
  cwd: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  mcpServers: z.array(AcpMcpServerSchema).optional(),
  permissions: AcpPermissionPolicySchema.optional(),
  clientCapabilities: AcpClientCapabilityConfigSchema.optional(),
  session: AcpSessionPolicySchema.optional(),
});

/** @public Zod schema validating a single `WorkflowNode` (any JSON-safe kind). */
export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z
  .discriminatedUnion('kind', [
    CallModelNodeSchema,
    InvokeToolNodeSchema,
    RunCodeNodeSchema,
    ConditionalNodeSchema,
    InParallelNodeSchema,
    SpawnNodeSchema,
    WithContextNodeSchema,
    LoopNodeSchema,
    SequenceNodeSchema,
    ScheduleNodeSchema,
    SubflowNodeSchema,
    AcpAgentNodeSchema,
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
    case 'inParallel':
      if (node.each) {
        return [
          node.each,
        ];
      }
      return node.paths ?? [];
    case 'spawn':
    case 'withContext':
      return [
        node.child,
      ];
    case 'loop':
      return [
        node.body,
      ];
    case 'schedule':
      return [
        node.step,
      ];
    case 'conditional': {
      const children = node.routes.map((r) => r.target);
      if (node.default) {
        children.push(node.default);
      }
      return children;
    }
    case 'subflow':
      // A named ref is a static leaf: the target document is only known at
      // hydration time, so walk/graph/depth cannot see through it.
      return node.document
        ? [
            node.document.root,
          ]
        : [];
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

/** A flattened, JSON-safe view of a workflow tree: its nodes and parent→child edges. */
export interface WorkflowGraph {
  nodes: Array<{
    id: string;
    kind: WorkflowNode['kind'];
  }>;
  edges: Array<{
    from: string;
    to: string;
  }>;
}

/**
 * Flattens a workflow tree into a node + edge list — the static "potential
 * paths" of the DAG, suitable for attaching to a trace span so observers can
 * reconstruct the declared graph independent of which branches actually ran.
 * `subflow` refs are leaves: their target documents resolve at hydration time.
 */
export function workflowGraph(root: WorkflowNode): WorkflowGraph {
  const nodes: WorkflowGraph['nodes'] = [];
  const edges: WorkflowGraph['edges'] = [];
  for (const node of walkWorkflow(root)) {
    nodes.push({
      id: node.id,
      kind: node.kind,
    });
    for (const child of childNodes(node)) {
      edges.push({
        from: node.id,
        to: child.id,
      });
    }
  }
  return {
    nodes,
    edges,
  };
}

/**
 * Returns the maximum depth of a workflow tree.
 * Leaf nodes (`callModel`, `invokeTool`) have depth 0. Structural nodes add +1.
 * A `subflow` ref counts as a leaf — depth does not see through named refs.
 */
export function workflowDepth(node: WorkflowNode): number {
  const children = childNodes(node);
  if (children.length === 0) {
    return 0;
  }
  return 1 + Math.max(0, ...children.map(workflowDepth));
}

//#endregion
