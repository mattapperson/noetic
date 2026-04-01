import type { FieldMapping } from '../../types/adapter';

export const VERCEL_AI_MAPPINGS: Record<string, FieldMapping> = {
  streamText: {
    '0.instructions': 'prompt',
    '0.prompt': 'prompt',
  },
  generateText: {
    '0.instructions': 'prompt',
    '0.prompt': 'prompt',
  },
  tool: {
    '0.description': 'description',
  },
};
