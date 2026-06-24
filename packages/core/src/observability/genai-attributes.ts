// GenAI Semantic Convention attributes
export const GenAI = {
  SYSTEM: 'gen_ai.system',
  REQUEST_MODEL: 'gen_ai.request.model',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
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
} as const;
