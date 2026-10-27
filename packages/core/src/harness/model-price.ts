/**
 * Published model prices, for bounding what a cut-off call can have cost.
 */

import type { OpenRouter } from '@openrouter/sdk';

//#region Types

/** @internal How long one provider lookup may take before it counts as failed. */
export const LOOKUP_TIMEOUT_MS = 10e3;

/** @internal The slice of the SDK client a price lookup uses. */
export type PriceClient = Pick<OpenRouter, 'models'>;

/** @internal The most USD per token the model charges under any condition, and its caps. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Flat USD per request. */
  request: number;
  maxOutput?: number;
  contextLength?: number;
}

/** @internal What bounds one call: its prompt's token bound and its own output cap. */
export interface TokenBound {
  inputTokens: number;
  maxOutputTokens?: number;
}

/** @internal A request body as sent, and the most prompt tokens it can cost. */
export interface MeasuredRequest {
  json: string;
  inputTokens: number;
}

/** Prompt tokens a provider may add around one request: chat template, tool-use preamble. */
const FRAMING_TOKENS = 1024;

/** Prompt tokens one image, file, audio, or video part may cost. */
const MEDIA_TOKENS = 4096;

/** Content part types that carry media rather than text, across the request shapes sent. */
const MEDIA_TYPES = new Set([
  'image_url',
  'input_image',
  'file',
  'input_file',
  'input_audio',
  'input_video',
  'video_url',
]);

//#endregion

//#region Public API

/**
 * @internal
 * Price lookup, cached per model. A failed lookup is not cached. Resolves `undefined`
 * when the model publishes no price or the lookup failed.
 */
export function createPriceBook(
  client: () => PriceClient | undefined,
): (model: string) => Promise<ModelPrice | undefined> {
  const prices = new Map<string, Promise<ModelPrice | undefined>>();
  return (model) => {
    const known = prices.get(model);
    if (known) {
      return known;
    }
    const lookup = lookupPrice(model, client());
    prices.set(model, lookup);
    void lookup.then((price) => {
      if (price === undefined) {
        prices.delete(model);
      }
    });
    return lookup;
  };
}

/**
 * @internal
 * Serialize a request body and bound the prompt tokens it can cost.
 *
 * Byte-level BPE (GPT, Claude, Llama 3) and SentencePiece with byte fallback (Gemini,
 * Mistral) spend at most one token per UTF-8 byte of text, and the JSON body holds
 * every byte of the prompt's text, so its byte length bounds the text's tokens. The
 * provider's own framing and each media part are not in those bytes: an image sent
 * by URL is a few bytes that cost hundreds of tokens. Each gets a fixed allowance.
 */
export function measureRequest(body: unknown): MeasuredRequest {
  let media = 0;
  const json =
    JSON.stringify(body, (_key, value: unknown) => {
      if (isMediaPart(value)) {
        media += 1;
      }
      return value;
    }) ?? '';
  return {
    json,
    inputTokens: new TextEncoder().encode(json).length + FRAMING_TOKENS + media * MEDIA_TOKENS,
  };
}

/**
 * @internal
 * USD a call can have cost at most, or undefined when no output cap is known. The
 * output cap is the request's own, else the model's published max output, else the
 * model's context, which the prompt and output share.
 */
export function ceilingOf(bound: TokenBound, price: ModelPrice): number | undefined {
  const context = price.contextLength;
  // The provider refuses or trims a prompt longer than the context.
  const prompt = context === undefined ? bound.inputTokens : Math.min(bound.inputTokens, context);
  const outputCap = bound.maxOutputTokens ?? price.maxOutput;
  if (outputCap !== undefined) {
    return price.input * prompt + price.output * outputCap + price.request;
  }
  if (context === undefined) {
    return undefined;
  }
  // A shorter prompt leaves more room for output, so the cost peaks at one end of
  // the prompt's range: no prompt at all, or the longest it can be.
  const longest = price.input * prompt + price.output * (context - prompt);
  return Math.max(longest, price.output * context) + price.request;
}

//#endregion

//#region Helpers

function isMediaPart(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    MEDIA_TYPES.has(value.type)
  );
}

async function lookupPrice(
  model: string,
  client: PriceClient | undefined,
): Promise<ModelPrice | undefined> {
  const slash = model.indexOf('/');
  if (!client || slash <= 0) {
    return undefined;
  }
  try {
    const { data } = await client.models.get(
      {
        author: model.slice(0, slash),
        slug: model.slice(slash + 1),
      },
      {
        timeoutMs: LOOKUP_TIMEOUT_MS,
      },
    );
    const { pricing } = data;
    const base = Number(pricing.prompt);
    const completion = Number(pricing.completion);
    if (!Number.isFinite(base) || !Number.isFinite(completion) || base < 0 || completion < 0) {
      return undefined;
    }
    // Long prompts, cache writes, and reasoning can each bill above the base price,
    // so a bound takes the dearest of every condition the model publishes.
    const tiers = [
      pricing,
      ...(pricing.overrides ?? []),
    ];
    const context = Math.max(data.topProvider.contextLength ?? 0, data.contextLength ?? 0);
    return {
      input: dearest(
        tiers.flatMap((tier) => [
          tier.prompt,
          tier.inputCacheWrite,
          tier.inputCacheWrite1h,
        ]),
      ),
      output: dearest([
        ...tiers.map((tier) => tier.completion),
        pricing.internalReasoning,
      ]),
      request: dearest([
        pricing.request,
      ]),
      maxOutput: data.topProvider.maxCompletionTokens ?? undefined,
      // OpenRouter may route to any provider, so the widest context bounds the prompt.
      contextLength: context > 0 ? context : undefined,
    };
  } catch {
    // An unknown price leaves the hold unbounded, which `spend_pending` flags.
    return undefined;
  }
}

/** The highest of some published USD prices; an absent or malformed one counts as free. */
function dearest(prices: ReadonlyArray<string | undefined>): number {
  let most = 0;
  for (const price of prices) {
    const value = Number(price);
    if (Number.isFinite(value) && value > most) {
      most = value;
    }
  }
  return most;
}

//#endregion
