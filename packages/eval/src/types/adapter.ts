export type FieldMapping = Record<string, 'prompt' | 'description' | 'text'>;

export interface AdapterConfig {
  provider: string;
  wrap: Record<string, (...args: unknown[]) => unknown>;
  fields?: Record<string, FieldMapping>;
  skill?: string;
}
