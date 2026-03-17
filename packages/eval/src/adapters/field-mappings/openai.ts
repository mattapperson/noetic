import type { FieldMapping } from '../../types/adapter';

export const OPENAI_MAPPINGS: Record<string, FieldMapping> = {
  'chat.completions.create': {
    '0.messages': 'prompt',
  },
  tool: {
    '0.function.description': 'description',
  },
};
