/**
 * Published model prices, for bounding what a cut-off call can have cost.
 */

import type { OpenRouter } from '@openrouter/sdk';

//#region Types

/** @internal How long one provider lookup may take before it counts as failed. */
export const LOOKUP_TIMEOUT_MS = 10e3;

/** @internal The slice of the SDK client a price lookup uses. */
export type PriceClient = Pick<OpenRouter, 'models'>;

/** @internal USD per token, and the output cap the model publishes. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Flat USD per request. */
  request: number;
  maxOutput?: number;
  contextLength?: number;
}

/** @internal What bounds one call: its prompt estimate and its own output cap. */
export interface TokenBound {
  inputTokens: number;
  maxOutputTokens?: number;
}

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
 * USD a call can have cost at most, or undefined when no output cap is known. The
 * output cap is the request's own, else the model's published max output, else what
 * its context leaves after the prompt.
 */
export function ceilingOf(bound: TokenBound, price: ModelPrice): number | undefined {
  const outputCap =
    bound.maxOutputTokens ??
    price.maxOutput ??
    (price.contextLength !== undefined
      ? Math.max(0, price.contextLength - bound.inputTokens)
      : undefined);
  if (outputCap === undefined) {
    return undefined;
  }
  return price.input * bound.inputTokens + price.output * outputCap + price.request;
}

//#endregion

//#region Helpers

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
    const input = Number(data.pricing.prompt);
    const output = Number(data.pricing.completion);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      return undefined;
    }
    const request = Number(data.pricing.request ?? 0);
    return {
      input,
      output,
      request: Number.isFinite(request) && request > 0 ? request : 0,
      maxOutput: data.topProvider.maxCompletionTokens ?? undefined,
      contextLength: data.topProvider.contextLength ?? data.contextLength ?? undefined,
    };
  } catch {
    // An unknown price leaves the hold unbounded, which `spend_pending` flags.
    return undefined;
  }
}

//#endregion
