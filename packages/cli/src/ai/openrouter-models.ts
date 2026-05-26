/**
 * OpenRouter model catalog fetcher.
 *
 * Fetches the public model list from OpenRouter's `/api/v1/models` endpoint
 * so the CLI can show an up-to-date picker keyed by OpenRouter model slug
 * (e.g. `anthropic/claude-sonnet-4`). The result is memoized per process so
 * reopening the picker is instant.
 */

import { z } from 'zod';

import type { FetchLike } from './plugin-call-model.js';

export type { FetchLike };

//#region Types

const PricingSchema = z
  .object({
    prompt: z.string().optional(),
    completion: z.string().optional(),
  })
  .passthrough();

const ModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    context_length: z.number().optional(),
    pricing: PricingSchema.optional(),
  })
  .passthrough();

const ModelsResponseSchema = z.object({
  data: z.array(ModelSchema),
});

export interface OpenRouterModel {
  /** OpenRouter slug, e.g. `anthropic/claude-sonnet-4`. Used as the model id. */
  id: string;
  /** Human-readable name from OpenRouter, e.g. "Anthropic: Claude Sonnet 4". */
  name: string;
  /** Short description (truncated by the picker). */
  description: string;
  /** Context window in tokens, or 0 if unknown. */
  contextLength: number;
  /** Prompt price in USD per token (for display). 0 if unknown. */
  promptPrice: number;
  /** Completion price in USD per token (for display). 0 if unknown. */
  completionPrice: number;
}

//#endregion

//#region Fetcher

const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60 * 60 * 1e3;

interface CacheEntry {
  models: ReadonlyArray<OpenRouterModel>;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<ReadonlyArray<OpenRouterModel>> | null = null;

function parsePrice(raw: string | undefined): number {
  if (!raw) {
    return 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

interface FetchModelsOptions {
  endpoint?: string;
  fetchFn?: FetchLike;
  signal?: AbortSignal;
  /** When true, ignore the in-memory cache. */
  force?: boolean;
}

interface FetchModelsArgs {
  endpoint: string;
  fetchFn: FetchLike;
  signal: AbortSignal | undefined;
}

async function fetchModelsNow(args: FetchModelsArgs): Promise<ReadonlyArray<OpenRouterModel>> {
  const response = await args.fetchFn(args.endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal: args.signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenRouter models: ${response.status} ${response.statusText}`);
  }
  const parsed = ModelsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Malformed OpenRouter models response: ${parsed.error.message}`);
  }
  const models: OpenRouterModel[] = parsed.data.data.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    description: m.description ?? '',
    contextLength: m.context_length ?? 0,
    promptPrice: parsePrice(m.pricing?.prompt),
    completionPrice: parsePrice(m.pricing?.completion),
  }));
  cache = {
    models,
    fetchedAt: Date.now(),
  };
  return models;
}

export async function fetchOpenRouterModels(
  options: FetchModelsOptions = {},
): Promise<ReadonlyArray<OpenRouterModel>> {
  const { endpoint = DEFAULT_ENDPOINT, fetchFn = fetch, signal, force = false } = options;

  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }
  if (!force && inflight) {
    return inflight;
  }

  inflight = fetchModelsNow({
    endpoint,
    fetchFn,
    signal,
  });
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Clears the in-memory model cache. Exposed for tests. */
export function clearOpenRouterModelCache(): void {
  cache = null;
  inflight = null;
}

//#endregion
