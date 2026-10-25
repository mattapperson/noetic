import { LAYER_HOOK_EVENT, SPAWN_SUMMARY_FAILED_EVENT } from '@noetic-tools/context';

// GenAI Semantic Convention attributes
export const GenAI = {
  SYSTEM: 'gen_ai.system',
  REQUEST_MODEL: 'gen_ai.request.model',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  /** Prompt tokens served from the provider's cache. Absent if unreported. */
  USAGE_CACHED_INPUT_TOKENS: 'gen_ai.usage.cached_input_tokens',
  /** Prompt tokens written into the provider's cache. Absent if unreported. */
  USAGE_CACHE_WRITE_TOKENS: 'gen_ai.usage.cache_write_tokens',
  COST: 'gen_ai.cost',
} as const;

export const ToolAttr = {
  NAME: 'tool.name',
  NEEDS_APPROVAL: 'tool.needs_approval',
  /**
   * How the approver settled a call to a tool that declares `needsApproval`:
   * `approved`, `denied`, or `none_configured` (the harness has no approver,
   * so the call ran unapproved). Absent when the call never reached the
   * approval stage.
   */
  APPROVAL: 'tool.approval',
} as const;

// Noetic-specific span attributes describing the static workflow graph (the
// "potential paths" of the DAG) carried on the root `workflow.run` span.
export const NoeticAttr = {
  /** Full JSON-serialised `WorkflowDocument` (the DAG, lossless). */
  WORKFLOW_DOCUMENT: 'noetic.workflow.document',
  /** Workflow document schema version. */
  WORKFLOW_VERSION: 'noetic.workflow.version',
  /** Count of declared nodes in the workflow tree. */
  WORKFLOW_NODE_COUNT: 'noetic.workflow.node_count',
  /** JSON array of `{ id, kind }` for every declared node (flattened graph). */
  WORKFLOW_NODES: 'noetic.workflow.nodes',
  /** JSON array of `{ from, to }` parent→child edges between declared nodes. */
  WORKFLOW_EDGES: 'noetic.workflow.edges',
  /**
   * Id of the step a span belongs to: the `callModel` step of an
   * `llm.call`/`tool.call` (or the `invokeTool` step of its `tool.call`), the `decide` step of a `decide.call`, the `spawn`
   * step of a `spawn` span, the path step of an `inParallel.path` span.
   */
  NODE_ID: 'noetic.node.id',
  /** Id of the `inParallel` step an `inParallel.path` span belongs to. */
  PARALLEL_ID: 'noetic.parallel.id',
  /** Zero-based position of the path among its `inParallel` siblings. */
  PARALLEL_INDEX: 'noetic.parallel.index',
  /** `NoeticError` kind a `spawn`/`inParallel.path` span failed with. */
  ERROR_KIND: 'noetic.error.kind',
  /**
   * Conversation/session this run belongs to (the run's `ctx.threadId`). Stamped
   * on the root `workflow.run` span so every turn of a multi-turn session shares
   * one id, letting a consumer group per-run traces back into their session.
   */
  SESSION_ID: 'noetic.session.id',
  /** Resource the session is scoped to (the run's `ctx.resourceId`), when set. */
  RESOURCE_ID: 'noetic.resource.id',
  /** Id of the anchoring epoch the assembled view belongs to. */
  CONTEXT_EPOCH_ID: 'noetic.context.epoch.id',
  /** Assemblies served by the current epoch, including this one. */
  CONTEXT_EPOCH_AGE: 'noetic.context.epoch.age',
  /** Why the epoch re-anchored on this assembly, when it did. */
  CONTEXT_REANCHOR_REASON: 'noetic.context.reanchor_reason',
  /** Tokens in the anchor band (the cache-stable prefix). */
  CONTEXT_ANCHOR_TOKENS: 'noetic.context.anchor_tokens',
  /** Tokens in the live band (rendered after history). */
  CONTEXT_LIVE_TOKENS: 'noetic.context.live_tokens',
  /** Tokens spent superseding stale anchors. */
  CONTEXT_DELTA_TOKENS: 'noetic.context.delta_tokens',
  /** JSON array of `{ id, placement, served, changed }` per contributing layer. */
  CONTEXT_LAYER_PLACEMENTS: 'noetic.context.layer_placements',
  /** JSON array of `{ id, rate, rebillTokens }` per contributing layer. */
  CONTEXT_LAYER_CHURN: 'noetic.context.layer_churn',
  /** `native` or `estimated` — where a decision's probabilities came from. */
  DECISION_SOURCE: 'noetic.decision.source',
  /** Comma-separated ids of questions the model refused. */
  DECISION_REFUSED: 'noetic.decision.refused',
  /** Prefix for per-question attributes: `noetic.decision.<id>.value` etc. */
  DECISION_PREFIX: 'noetic.decision.',
} as const;

// Span event names. Steps that open no span of their own (e.g. `loop`) add
// these to the enclosing `ctx.span`.
export const NoeticEvent = {
  /** One per loop iteration: `{ loop, iteration, stop, reason? }`. */
  LOOP_VERDICT: 'loop.verdict',
  /** A channel dropped data or is waiting with no timeout: `{ kind, channelName, message, capacity?, operation? }`. */
  CHANNEL_WARNING: 'channel.warning',
  /**
   * A layer's `onReturn` hook failed, so a spawn or inParallel path returned
   * its result unchanged. Added to the child's span: `{ stepId, layerId,
   * message }`. Defined in `@noetic-tools/context`, whose `returnLayers`
   * emits it and cannot import core.
   */
  SPAWN_SUMMARY_FAILED: SPAWN_SUMMARY_FAILED_EVENT,
  /**
   * One per call of a traced layer hook (`init`, `recall`, `store`, `onSpawn`,
   * `onReturn`, `onComplete`, `dispose`), on the span of the context the hook
   * runs in: `{ layerId, hook, duration, status, itemCount?, budget.allocated?,
   * budget.used?, budget.yielded?, error.message? }`. Defined in
   * `@noetic-tools/context`, whose lifecycle emits it.
   */
  LAYER_HOOK: LAYER_HOOK_EVENT,
} as const;
