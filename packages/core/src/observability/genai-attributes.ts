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
  /** Id of the declared workflow node an `llm.call`/`tool.call` span belongs to. */
  NODE_ID: 'noetic.node.id',
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
  /** JSON array of `{ id, placement, served }` per contributing layer. */
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
