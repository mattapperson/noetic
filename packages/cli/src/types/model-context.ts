/**
 * Context-window heuristics for hosted LLM models. Used by the `/context` command
 * and by plugins (e.g. `@noetic/plugin-powerline`) that need to display usage
 * as a fraction of a model's limit.
 */

const DEFAULT_CONTEXT_LIMIT = 2e5;

const MODEL_CONTEXT_LIMITS: ReadonlyArray<
  [
    string,
    number,
  ]
> = [
  [
    'claude-opus-4-6',
    2e5,
  ],
  [
    'claude-sonnet-4-6',
    2e5,
  ],
  [
    'claude-haiku-4-5',
    2e5,
  ],
  [
    'claude-sonnet-4',
    2e5,
  ],
  [
    'claude-opus-4',
    2e5,
  ],
  [
    'claude-3-7',
    2e5,
  ],
  [
    'claude-3-5',
    2e5,
  ],
  [
    'gpt-5',
    4e5,
  ],
  [
    'gpt-4o',
    128e3,
  ],
  [
    'gpt-4',
    128e3,
  ],
  [
    'gemini-2',
    1e6,
  ],
];

export function getModelContextLimit(modelId: string): number {
  if (modelId.includes('[1m]')) {
    return 1e6;
  }
  const bare = modelId.replace(/^[^/]+\//, '').replace(/\[[^\]]*\]$/, '');
  for (const [prefix, limit] of MODEL_CONTEXT_LIMITS) {
    if (bare.startsWith(prefix)) {
      return limit;
    }
  }
  return DEFAULT_CONTEXT_LIMIT;
}

export function formatTokens(n: number): string {
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}k`;
  }
  return String(n);
}
