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
