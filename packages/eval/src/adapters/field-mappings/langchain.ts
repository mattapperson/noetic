import type { FieldMapping } from '../../types/adapter';

export const LANGCHAIN_MAPPINGS: Record<string, FieldMapping> = {
  fromTemplate: {
    '0': 'prompt',
  },
  Tool: {
    '0.description': 'description',
  },
};
