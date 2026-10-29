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
import type { ToolChoice } from '../types/common';
import { ServiceTier, ToolChoiceMode } from '../types/common';
import type { BlobRef, Ref } from '../types/connection';
import { BlobRefSchema, RefSchema } from '../types/connection';
import type { DecideQuestion } from '../types/decide';
import { DecideQuestionsSchema, routeOutcomes } from '../types/decide';
import { isSenseId, parseProfileRequirement } from '../types/profile';
import type { DecideView } from '../types/step';
import { isValidRange } from '../util/semver';
import type { Claim, Constraint } from '../verify/ovp';
import { OvpClaimSchema, OvpConstraintSchema } from '../verify/schemas';
import type { VerifyMatcher } from '../verify/verifier';
import type { Expression } from './expression';
import { ExpressionSchema } from './expression';

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
  | {
      kind: 'expr';
      expr: Expression;
    }
  | UntilAnyPredicate
  | UntilAllPredicate
  | DecideWorkflowNode;

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

const ExprPredicateSchema = z.object({
  kind: z.literal('expr'),
  expr: ExpressionSchema,
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

// Declared with the node schemas below; lazy so the union can name it here.
const UntilDeciderRef: z.ZodType<DecideWorkflowNode> = z.lazy(() => UntilDeciderSchema);

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
    ExprPredicateSchema,
    AnyPredicateSchema,
    AllPredicateSchema,
    UntilDeciderRef,
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
  serviceTier: z.enum(ServiceTier).optional(),
});

const ToolChoiceSchema = z.union([
  z.enum(ToolChoiceMode),
  z.object({
    tool: z.string().min(1),
  }),
]);

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
  /**
   * How long the connection is kept alive. Defaults to `step`; `run` and
   * `harness` are explicit opt-ins because a connection owns a live agent.
   */
  keepAlive: z
    .enum([
      'step',
      'run',
      'harness',
    ])
    .optional(),
  load: z.string().min(1).optional(),
});

//#endregion

//#region Workflow Node Types

/**
 * @public
 * Which part of a node's input names the work it does, so a resumed run replays the
 * node by content rather than by position. `true` keys on the whole input. `from`
 * keys on those top-level properties of the input parsed as a JSON object — the same
 * lookup an `inParallel` node's `over` does. See spec 26 § Replay keys.
 */
export type WorkflowReplayKey =
  | true
  | {
      from: string[];
    };

/**
 * @public
 * What a node emits (spec 34 § JSON nodes). `true` emits its output as a final item:
 * a string as an assistant message, an object whose `type` names a custom item in
 * scope as that item. The hook form names a declared `item`: `onStart`, evaluated
 * against the input, gives one event; `onDone`, evaluated against the output, gives
 * the final item's fields. Without `item`, `onDone` gives message text.
 */
export type WorkflowEmitItems =
  | boolean
  | {
      item?: string;
      onStart?: Expression;
      onDone?: Expression;
    };

/**
 * @public
 * A custom item a document declares (spec 34), in JSON Schema. `type` is
 * `prefix:name`; `event` describes what streams, `output` the final item's fields.
 */
export interface WorkflowCustomItem {
  type: string;
  description?: string;
  event?: Record<string, unknown>;
  output: Record<string, unknown>;
}

interface WorkflowNodeBase {
  id: string;
  /**
   * Whether a resumed run replays this node's recorded output. Defaults to `true`;
   * `false` makes the node run again on every resume. See spec 23a § Identity.
   */
  durable?: boolean;
  /** Replay this node by its input instead of its position. Ignored when `durable` is `false`. */
  replayKey?: WorkflowReplayKey;
  /** Emit items when this node finishes. See spec 26 § Emitting items. */
  emitItems?: WorkflowEmitItems;
  /** Custom items only this node may emit. See spec 34 § On a step. */
  customItems?: Record<string, WorkflowCustomItem>;
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
  /**
   * How the model may use its tools: `"auto"` (default), `"required"`,
   * `"none"`, or `{ "tool": "<registered-tool-name>" }` to force one client
   * tool from `tools`.
   */
  toolChoice?: ToolChoice;
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

/** A node that computes a value from its input with an expression (spec 33). */
export interface ComputeWorkflowNode extends WorkflowNodeBase {
  kind: 'compute';
  expr: Expression;
}

/**
 * A `conditional` route. Supply exactly one test: `match` (case-insensitive
 * substring of the input's text) or `expr` (an expression that must give a
 * boolean; the route is taken on `true`).
 */
export interface ConditionalRoute {
  match?: string;
  expr?: Expression;
  target: WorkflowNode;
}

export interface ConditionalWorkflowNode extends WorkflowNodeBase {
  kind: 'conditional';
  routes: ConditionalRoute[];
  default?: WorkflowNode;
}

/** A node that asks typed questions of a decision model. See spec 32. */
export interface DecideWorkflowNode extends WorkflowNodeBase {
  kind: 'decide';
  model?: string;
  instructions?: string;
  questions: Record<string, DecideQuestion>;
  view?: DecideView;
  samples?: number;
}

/** A node that routes to a case by one question of a decision. See spec 32. */
export interface RouteSwitchWorkflowNode extends WorkflowNodeBase {
  kind: 'routeSwitch';
  decide: DecideWorkflowNode;
  /** Question id to route by. */
  on: string;
  /** One case per outcome of the `on` question. */
  cases: Record<string, WorkflowNode>;
  minConfidence?: number;
  /** Taken on refusal, or when confidence is below `minConfidence`. */
  uncertain: WorkflowNode;
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
   * array. Only meaningful with `each`. A list of connection names instead fans
   * `each` out over those connections, each name checked against the manifest
   * and bound to `$item` (spec 35 § JSON workflows).
   */
  over?: string | string[];
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
  /** `'forward'` lets the child apply steers sent while it runs; default `'hold'`. */
  steers?: 'forward' | 'hold';
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
  /**
   * Hard cap on iterations: a positive integer, or `'infinity'` for none
   * (JSON cannot encode `Infinity`). Default: 1000.
   */
  maxIterations?: number | 'infinity';
}

export interface SequenceWorkflowNode extends WorkflowNodeBase {
  kind: 'sequence';
  /** Nodes, or operations written by name (`{ "ui.tap": { … } }`), run in order. */
  steps: WorkflowStepEntry[];
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

//#region Connection Node Types

/** @public `{ "$expr": "…" }`: an expression evaluated against the node's input (spec 33). */
export interface WorkflowExprValue {
  $expr: Expression;
}

/** @public `{ "$literal": … }`: passes a value through untouched. */
export interface WorkflowLiteralValue {
  $literal: unknown;
}

/** @public `{ "$secret": "name" }`: a secret, resolved only when the call is sent. */
export interface WorkflowSecretValue {
  $secret: string;
}

/**
 * @public
 * A value in a connection node's arguments: JSON, an expression, a literal, a
 * secret, or a ref or blob as it was returned. Object keys starting with `$`
 * are reserved for these wrappers; wrap such data in `$literal`.
 */
export type WorkflowValue =
  | null
  | boolean
  | number
  | string
  | WorkflowValue[]
  | WorkflowExprValue
  | WorkflowLiteralValue
  | WorkflowSecretValue
  | Ref
  | BlobRef
  | {
      [key: string]: WorkflowValue;
    };

/** @public A node's arguments: an object of values, or one expression computing them all. */
export type WorkflowArgs =
  | {
      [field: string]: WorkflowValue;
    }
  | WorkflowExprValue;

/** @public A connection by manifest name, or an expression (`{ "$expr": "$item" }` in a fan-out). */
export type WorkflowConnectionRef = string | WorkflowExprValue;

/**
 * @public
 * An operation written by name inside an array of steps: `{ "ui.tap": { "element": "button \"Pay\"" } }`
 * is a `call` on the enclosing connection (the `verify` subject, or the
 * document's only connection).
 */
export type WorkflowOpShorthand = {
  [op: string]: WorkflowArgs;
};

/** @public One entry of an array of steps: a node, or an operation written by name. */
export type WorkflowStepEntry = WorkflowNode | WorkflowOpShorthand;

/** @public What `around` and `act` take: a step, or an array of steps run in sequence. */
export type WorkflowStepList = WorkflowStepEntry | WorkflowStepEntry[];

/** @public Runs one connection operation and returns its result (spec 35). */
export interface CallWorkflowNode extends WorkflowNodeBase {
  kind: 'call';
  /** Defaults to the enclosing connection (a `verify` subject, or the document's only connection). */
  connection?: WorkflowConnectionRef;
  op: string;
  args?: WorkflowArgs;
}

/** @public Waits for a connection event; with `around`, listens first, runs `around`, then waits. Output `{ event, around }`. */
export interface WaitWorkflowNode extends WorkflowNodeBase {
  kind: 'wait';
  connection?: WorkflowConnectionRef;
  event: string;
  /** Evaluated against `{ "event": <the event>, "input": <the node's input> }`; the event matches on `true`. */
  filter?: Expression;
  around?: WorkflowStepList;
  timeoutMs: number;
}

/**
 * @public
 * A verify matcher in JSON: exactly one sense key (`ui`, `net`, `log`, `route`,
 * `state`, `signal`, `storage`, `time`, `visual`, `x-…`) or `event`, with its
 * matcher text, plus optional bounds: `{ "net": "POST /api/orders 201", "count": 1 }`.
 */
export type WorkflowVerifyMatcher = {
  count?: number;
  atLeast?: number;
  atMost?: number;
  equals?: number | string | boolean;
  tolerance?: number;
  [sense: string]: string | number | boolean | undefined;
};

/** @public When a verify's window closes. */
export interface WorkflowVerifyClose {
  until?: 'quiet' | 'event' | 'done' | 'exit';
  event?: string;
  quietMs?: number;
  timeoutMs?: number;
}

/** @public Checks claims about what a connection shows (spec 37). */
export interface VerifyWorkflowNode extends WorkflowNodeBase {
  kind: 'verify';
  /** The connection checked, or a list (one verify per connection, ids `<id>.<name>`). */
  subject: string | string[] | WorkflowExprValue;
  expect?: WorkflowVerifyMatcher[];
  never?: WorkflowVerifyMatcher[];
  /** OVP claims given directly, instead of `expect`. */
  claims?: Claim[];
  /** OVP constraints given directly, instead of `never`. */
  constraints?: Constraint[];
  /** Steps run on the subject unless they name another connection. */
  act: WorkflowStepList;
  witnesses?: string[];
  close?: WorkflowVerifyClose;
  intent?: string;
}

/**
 * @public
 * A connection a document needs: a `profile` with a range, `extensions` with
 * ranges, or for a source the `events` it needs; plus `from`, `fresh` and
 * `setup` for pooled connections (spec 35 § JSON workflows).
 */
export interface WorkflowConnectionRequirement {
  /** `<profile>@<range>`, e.g. `browser@^1.2`. */
  profile?: string;
  /** Extension id → range. */
  extensions?: Record<string, string>;
  /** Event types a source must offer. */
  events?: string[];
  from?: string;
  fresh?: 'run' | 'path';
  setup?: Record<string, unknown>;
}

//#endregion

/** @public Discriminated union of all JSON-serialisable workflow node kinds. */
export type WorkflowNode =
  | CallModelWorkflowNode
  | InvokeToolWorkflowNode
  | RunCodeWorkflowNode
  | ComputeWorkflowNode
  | ConditionalWorkflowNode
  | DecideWorkflowNode
  | RouteSwitchWorkflowNode
  | InParallelWorkflowNode
  | SpawnWorkflowNode
  | WithContextWorkflowNode
  | LoopWorkflowNode
  | SequenceWorkflowNode
  | ScheduleWorkflowNode
  | SubflowWorkflowNode
  | AcpAgentWorkflowNode
  | CallWorkflowNode
  | WaitWorkflowNode
  | VerifyWorkflowNode;

//#endregion

//#region Workflow Node Schema

const WorkflowNodeRef: z.ZodType<WorkflowNode> = z.lazy(() => WorkflowNodeSchema);

const WorkflowReplayKeySchema: z.ZodType<WorkflowReplayKey> = z.union([
  z.literal(true),
  z.object({
    from: z.array(z.string().min(1)).min(1),
  }),
]);

const WorkflowEmitItemsSchema: z.ZodType<WorkflowEmitItems> = z.union([
  z.boolean(),
  z
    .object({
      item: z.string().min(1).optional(),
      onStart: ExpressionSchema.optional(),
      onDone: ExpressionSchema.optional(),
    })
    .strict()
    .refine((config) => config.onStart === undefined || config.item !== undefined, {
      message: "emitItems 'onStart' gives an event, so it needs an 'item' to emit.",
    }),
]);

const JsonSchemaObjectSchema = z.record(z.string(), z.unknown());

const WorkflowCustomItemSchema: z.ZodType<WorkflowCustomItem> = z
  .object({
    type: z.string().regex(/^[^:]+:.+$/, "A custom item type is 'prefix:name'."),
    description: z.string().optional(),
    event: JsonSchemaObjectSchema.optional(),
    output: JsonSchemaObjectSchema,
  })
  .strict();

const CustomItemsSchema = z.record(z.string().min(1), WorkflowCustomItemSchema);

const SHARED_FIELDS = {
  id: z.string().min(1),
  durable: z.boolean().optional(),
  replayKey: WorkflowReplayKeySchema.optional(),
  emitItems: WorkflowEmitItemsSchema.optional(),
  customItems: CustomItemsSchema.optional(),
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
  toolChoice: ToolChoiceSchema.optional(),
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

const ComputeNodeSchema = z.object({
  kind: z.literal('compute'),
  ...SHARED_FIELDS,
  expr: ExpressionSchema,
});

const ConditionalRouteSchema = z
  .object({
    match: z.string().min(1).optional(),
    expr: ExpressionSchema.optional(),
    target: WorkflowNodeRef,
  })
  .refine((route) => (route.match === undefined) !== (route.expr === undefined), {
    message:
      "conditional route requires exactly one of 'match' (substring) or 'expr' (expression).",
  });

const ConditionalNodeSchema = z.object({
  kind: z.literal('conditional'),
  ...SHARED_FIELDS,
  routes: z.array(ConditionalRouteSchema).min(1),
  default: WorkflowNodeRef.optional(),
});

const DecideNodeSchema = z.object({
  kind: z.literal('decide'),
  ...SHARED_FIELDS,
  model: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
  questions: DecideQuestionsSchema,
  view: z
    .enum([
      'full',
      'layers',
      'none',
    ])
    .optional(),
  samples: z.number().int().positive().optional(),
});

/** A decide node that ends a loop: exactly one question, and a boolean one. */
const UntilDeciderSchema = DecideNodeSchema.superRefine((node, issue) => {
  const questions = Object.values(node.questions);
  if (questions.length === 1 && questions[0]?.type === 'boolean') {
    return;
  }
  issue.addIssue({
    code: 'custom',
    path: [
      'questions',
    ],
    message: 'An until decider asks exactly one question, and it must be boolean.',
  });
});

const RouteSwitchNodeSchema = z
  .object({
    kind: z.literal('routeSwitch'),
    ...SHARED_FIELDS,
    decide: DecideNodeSchema,
    on: z.string().min(1),
    cases: z.record(z.string().min(1), WorkflowNodeRef),
    minConfidence: z.number().min(0).max(1).optional(),
    uncertain: WorkflowNodeRef,
  })
  .superRefine((node, issue) => {
    const question = Object.hasOwn(node.decide.questions, node.on)
      ? node.decide.questions[node.on]
      : undefined;
    if (!question) {
      issue.addIssue({
        code: 'custom',
        path: [
          'on',
        ],
        message: `routeSwitch 'on' names no question of its decide node: '${node.on}'.`,
      });
      return;
    }
    const missing = routeOutcomes(question).filter((o) => !Object.hasOwn(node.cases, o));
    if (missing.length > 0) {
      issue.addIssue({
        code: 'custom',
        path: [
          'cases',
        ],
        message: `routeSwitch cases miss outcomes of '${node.on}': ${missing.join(', ')}.`,
      });
    }
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
    over: z
      .union([
        z.string().min(1),
        z.array(z.string().min(1)).min(1),
      ])
      .optional(),
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
  steers: z
    .enum([
      'forward',
      'hold',
    ])
    .optional(),
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
  maxIterations: z
    .union([
      z.number().int().positive(),
      z.literal('infinity'),
    ])
    .optional(),
});

const SequenceStepEntryRef: z.ZodType<WorkflowStepEntry> = z.lazy(() =>
  z.union([
    WorkflowNodeRef,
    WorkflowOpShorthandSchema,
  ]),
);

const SequenceNodeSchema = z.object({
  kind: z.literal('sequence'),
  ...SHARED_FIELDS,
  steps: z.array(SequenceStepEntryRef).min(1),
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

//#region Connection Value and Node Schemas

const OP_NAME_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;
const CONNECTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const EVENT_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const SENSE_KEY_RE = /^(ui|net|log|route|state|signal|storage|time|visual|x-[a-z0-9-]+|event)$/;
const EXTENSION_ID_RE = /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/;
const MATCHER_BOUND_KEYS = new Set([
  'count',
  'atLeast',
  'atMost',
  'equals',
  'tolerance',
]);

const ExprValueSchema: z.ZodType<WorkflowExprValue> = z
  .object({
    $expr: ExpressionSchema,
  })
  .strict();

const LiteralValueSchema: z.ZodType<WorkflowLiteralValue> = z
  .object({
    $literal: z.unknown(),
  })
  .strict()
  .refine((v) => Object.hasOwn(v, '$literal'), {
    message: "A '$literal' wrapper needs a value.",
  });

const SecretValueSchema: z.ZodType<WorkflowSecretValue> = z
  .object({
    $secret: z.string().min(1),
  })
  .strict();

const PlainKeySchema = z
  .string()
  .regex(/^(?!\$)/, "Keys starting with '$' are reserved; wrap such data in '$literal'.");

/** @public Zod schema validating a `WorkflowValue`. */
export const WorkflowValueSchema: z.ZodType<WorkflowValue> = z
  .lazy(() => WorkflowValueUnionSchema)
  .meta({
    id: 'WorkflowValue',
    title: 'WorkflowValue',
    description:
      "A connection argument: JSON, { $expr }, { $literal }, { $secret }, or a { $ref } / { $blob } as it was returned. Keys starting with '$' are reserved.",
  });

const PlainObjectValueSchema = z.record(PlainKeySchema, WorkflowValueSchema).meta({
  id: 'WorkflowValueObject',
  title: 'WorkflowValueObject',
  description: "An object of connection argument values. Keys starting with '$' are reserved.",
});

const WorkflowValueUnionSchema: z.ZodType<WorkflowValue> = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(WorkflowValueSchema),
  ExprValueSchema,
  SecretValueSchema,
  RefSchema,
  BlobRefSchema,
  PlainObjectValueSchema,
  LiteralValueSchema,
]);

/** @public Zod schema validating `WorkflowArgs`. */
export const WorkflowArgsSchema: z.ZodType<WorkflowArgs> = z.union([
  ExprValueSchema,
  PlainObjectValueSchema,
]);

const ConnectionRefSchema: z.ZodType<WorkflowConnectionRef> = z.union([
  z.string().min(1),
  ExprValueSchema,
]);

/** @public Zod schema validating an operation written by name: exactly one `op.name` key. */
export const WorkflowOpShorthandSchema: z.ZodType<WorkflowOpShorthand> = z
  .record(
    z.string().regex(OP_NAME_RE, 'An operation name has at least one dot: ui.tap.'),
    WorkflowArgsSchema,
  )
  .refine((entry) => Object.keys(entry).length === 1, {
    message: 'An operation written by name has exactly one key: the operation.',
  });

const WorkflowStepEntrySchema: z.ZodType<WorkflowStepEntry> = z.union([
  WorkflowNodeRef,
  WorkflowOpShorthandSchema,
]);

const WorkflowStepListSchema: z.ZodType<WorkflowStepList> = z.union([
  WorkflowStepEntrySchema,
  z.array(WorkflowStepEntrySchema).min(1),
]);

const CallNodeSchema = z.object({
  kind: z.literal('call'),
  ...SHARED_FIELDS,
  connection: ConnectionRefSchema.optional(),
  op: z.string().regex(OP_NAME_RE),
  args: WorkflowArgsSchema.optional(),
});

const WaitNodeSchema = z.object({
  kind: z.literal('wait'),
  ...SHARED_FIELDS,
  connection: ConnectionRefSchema.optional(),
  event: z.string().regex(EVENT_NAME_RE),
  filter: ExpressionSchema.optional(),
  around: WorkflowStepListSchema.optional(),
  timeoutMs: z.number().positive(),
});

/** @public Zod schema validating a JSON verify matcher. */
export const WorkflowVerifyMatcherSchema: z.ZodType<WorkflowVerifyMatcher> = z
  .object({
    count: z.number().int().nonnegative().optional(),
    atLeast: z.number().int().nonnegative().optional(),
    atMost: z.number().int().nonnegative().optional(),
    equals: z
      .union([
        z.number(),
        z.string(),
        z.boolean(),
      ])
      .optional(),
    tolerance: z.number().nonnegative().optional(),
  })
  .catchall(z.string().min(1))
  .superRefine((matcher, issue) => {
    const keys = Object.keys(matcher).filter((k) => !MATCHER_BOUND_KEYS.has(k));
    const bad = keys.filter((k) => !SENSE_KEY_RE.test(k));
    if (bad.length > 0) {
      issue.addIssue({
        code: 'custom',
        message: `Unknown matcher key(s): ${bad.join(', ')}. Use a sense (ui, net, log, route, state, signal, storage, time, visual, x-…) or 'event'.`,
      });
      return;
    }
    if (keys.length !== 1) {
      issue.addIssue({
        code: 'custom',
        message: "A matcher names exactly one sense or 'event'.",
      });
      return;
    }
    if (
      matcher.count !== undefined &&
      (matcher.atLeast !== undefined || matcher.atMost !== undefined)
    ) {
      issue.addIssue({
        code: 'custom',
        message: "A matcher's 'count' is exact; it cannot be combined with 'atLeast' or 'atMost'.",
      });
    }
  });

const VerifyCloseSchema: z.ZodType<WorkflowVerifyClose> = z
  .object({
    until: z
      .enum([
        'quiet',
        'event',
        'done',
        'exit',
      ])
      .optional(),
    event: z.string().min(1).optional(),
    quietMs: z.number().nonnegative().optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict()
  .refine((close) => (close.until === 'event') === (close.event !== undefined), {
    message: "close.event is required with until: 'event', and only then.",
  });

const VerifyNodeSchema = z
  .object({
    kind: z.literal('verify'),
    ...SHARED_FIELDS,
    subject: z.union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1),
      ExprValueSchema,
    ]),
    expect: z.array(WorkflowVerifyMatcherSchema).min(1).optional(),
    never: z.array(WorkflowVerifyMatcherSchema).optional(),
    claims: z.array(OvpClaimSchema).min(1).optional(),
    constraints: z.array(OvpConstraintSchema).optional(),
    act: WorkflowStepListSchema,
    witnesses: z.array(z.string().min(1)).optional(),
    close: VerifyCloseSchema.optional(),
    intent: z.string().optional(),
  })
  .superRefine((node, issue) => {
    if ((node.expect === undefined) === (node.claims === undefined)) {
      issue.addIssue({
        code: 'custom',
        message:
          "verify node requires exactly one of 'expect' (matchers) or 'claims' (OVP claims).",
      });
    }
    if (node.never !== undefined && node.constraints !== undefined) {
      issue.addIssue({
        code: 'custom',
        message:
          "verify node takes 'never' (matchers) or 'constraints' (OVP constraints), not both.",
      });
    }
  });

/** @public Zod schema validating a `WorkflowConnectionRequirement`. */
export const WorkflowConnectionRequirementSchema: z.ZodType<WorkflowConnectionRequirement> = z
  .object({
    profile: z
      .string()
      .refine((p) => parseProfileRequirement(p) !== undefined, {
        message: "A profile requirement is '<profile>@<range>', e.g. 'browser@^1.2'.",
      })
      .optional(),
    extensions: z
      .record(
        z.string().regex(EXTENSION_ID_RE, 'An extension id is a reverse domain plus a name.'),
        z.string().refine(isValidRange, {
          message: 'Expected a semver range.',
        }),
      )
      .optional(),
    events: z.array(z.string().min(1)).min(1).optional(),
    from: z.string().regex(CONNECTION_NAME_RE).optional(),
    fresh: z
      .enum([
        'run',
        'path',
      ])
      .optional(),
    setup: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (entry) =>
      entry.profile !== undefined || entry.extensions !== undefined || entry.events !== undefined,
    {
      message:
        "A connection entry names a 'profile', 'extensions', or the 'events' a source must offer.",
    },
  );

const ConnectionsManifestSchema = z.record(
  z
    .string()
    .regex(
      CONNECTION_NAME_RE,
      'A connection name is a letter followed by letters, digits, _ or -.',
    ),
  WorkflowConnectionRequirementSchema,
);

//#endregion

/** @public Zod schema validating a single `WorkflowNode` (any JSON-safe kind). */
export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z
  .discriminatedUnion('kind', [
    CallModelNodeSchema,
    InvokeToolNodeSchema,
    RunCodeNodeSchema,
    ComputeNodeSchema,
    ConditionalNodeSchema,
    DecideNodeSchema,
    RouteSwitchNodeSchema,
    InParallelNodeSchema,
    SpawnNodeSchema,
    WithContextNodeSchema,
    LoopNodeSchema,
    SequenceNodeSchema,
    ScheduleNodeSchema,
    SubflowNodeSchema,
    AcpAgentNodeSchema,
    CallNodeSchema,
    WaitNodeSchema,
    VerifyNodeSchema,
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
  /** Custom items any node in this document may emit. See spec 34 § Workflow root. */
  customItems?: Record<string, WorkflowCustomItem>;
  /** The connections this document needs, by the names its nodes use. See spec 35 § JSON workflows. */
  connections?: Record<string, WorkflowConnectionRequirement>;
  root: WorkflowNode;
}

/** @public Zod schema validating a complete `WorkflowDocument`. */
export const WorkflowDocumentSchema: z.ZodType<WorkflowDocument> = z
  .object({
    version: z.literal(1),
    customItems: CustomItemsSchema.optional(),
    connections: ConnectionsManifestSchema.optional(),
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
      return nodesOf(node.steps);
    case 'wait':
      return node.around === undefined ? [] : nodesOf(node.around);
    case 'verify':
      return nodesOf(node.act);
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
        ...untilDeciders(node.until),
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
    case 'routeSwitch':
      return [
        node.decide,
        ...Object.values(node.cases),
        node.uncertain,
      ];
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

/** The nodes among a step list's entries; operations written by name are not nodes. */
function nodesOf(list: WorkflowStepList): WorkflowNode[] {
  return stepListEntries(list).filter(
    (entry): entry is WorkflowNode => !isWorkflowOpShorthand(entry),
  );
}

/** @public Whether a step entry is an operation written by name rather than a node. */
export function isWorkflowOpShorthand(entry: WorkflowStepEntry): entry is WorkflowOpShorthand {
  return !('kind' in entry && typeof entry.kind === 'string');
}

/** @public A step list's entries as an array (`around`/`act` take one entry or an array). */
export function stepListEntries(list: WorkflowStepList): WorkflowStepEntry[] {
  return Array.isArray(list)
    ? list
    : [
        list,
      ];
}

/**
 * @public
 * A step entry as a node: a node is returned as is; an operation written by
 * name becomes a `call` node with id `id` and no `connection`, so it runs on
 * the enclosing connection.
 */
export function stepEntryToNode(entry: WorkflowStepEntry, id: string): WorkflowNode {
  if (!isWorkflowOpShorthand(entry)) {
    return entry;
  }
  const [op, args] = Object.entries(entry)[0] ?? [
    '',
    undefined,
  ];
  const call: CallWorkflowNode = {
    kind: 'call',
    id,
    op,
  };
  if (args !== undefined) {
    call.args = args;
  }
  return call;
}

/**
 * @public
 * The id an operation written by name gets: its position under its parent,
 * `<parentId>[<index>]`.
 */
export function shorthandStepId(parentId: string, index: number): string {
  return `${parentId}[${index}]`;
}

/**
 * @public
 * A JSON verify matcher in its TypeScript form.
 * @returns The matcher, or `undefined` when it names no sense or event.
 */
export function verifyMatcherFromJson(json: WorkflowVerifyMatcher): VerifyMatcher | undefined {
  const key = Object.keys(json).find((k) => !MATCHER_BOUND_KEYS.has(k) && SENSE_KEY_RE.test(k));
  const value = key === undefined ? undefined : json[key];
  if (key === undefined || typeof value !== 'string') {
    return undefined;
  }
  const bounds = {
    ...(json.count === undefined
      ? {}
      : {
          count: json.count,
        }),
    ...(json.atLeast === undefined
      ? {}
      : {
          atLeast: json.atLeast,
        }),
    ...(json.atMost === undefined
      ? {}
      : {
          atMost: json.atMost,
        }),
  };
  if (key === 'event') {
    return {
      kind: 'event',
      event: value,
      ...bounds,
    };
  }
  if (!isSenseId(key)) {
    return undefined;
  }
  return {
    kind: 'sense',
    sense: key,
    match: value,
    ...bounds,
    ...(json.equals === undefined
      ? {}
      : {
          equals: json.equals,
        }),
    ...(json.tolerance === undefined
      ? {}
      : {
          tolerance: json.tolerance,
        }),
  };
}

/** Decide nodes inside an until predicate, `any`/`all` included, in order. */
function untilDeciders(pred: UntilPredicate): DecideWorkflowNode[] {
  if (pred.kind === 'decide') {
    return [
      pred,
    ];
  }
  if (pred.kind === 'any' || pred.kind === 'all') {
    return pred.predicates.flatMap(untilDeciders);
  }
  return [];
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
 * Leaf nodes (`callModel`, `invokeTool`, `runCode`, `compute`, `decide`) have depth 0. Structural nodes add +1.
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
