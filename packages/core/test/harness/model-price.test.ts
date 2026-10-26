import { describe, expect, it } from 'bun:test';
import { frameworkCast } from '@noetic-tools/types';
import type { PriceClient } from '../../src/harness/model-price';
import { ceilingOf, createPriceBook } from '../../src/harness/model-price';

const PRICE = {
  input: 1e-6,
  output: 1e-5,
  request: 0,
};

describe('ceilingOf', () => {
  it("prices the request's own output cap first", () => {
    expect(
      ceilingOf(
        {
          inputTokens: 100,
          maxOutputTokens: 50,
        },
        {
          ...PRICE,
          maxOutput: 1e3,
        },
      ),
    ).toBeCloseTo(1e-4 + 5e-4);
  });

  it("falls back to the model's published max output", () => {
    expect(
      ceilingOf(
        {
          inputTokens: 100,
        },
        {
          ...PRICE,
          maxOutput: 1e3,
          contextLength: 8e3,
        },
      ),
    ).toBeCloseTo(1e-4 + 1e-2);
  });

  it('then to what the context leaves after the prompt, plus the request price', () => {
    expect(
      ceilingOf(
        {
          inputTokens: 100,
        },
        {
          ...PRICE,
          request: 0.001,
          contextLength: 1100,
        },
      ),
    ).toBeCloseTo(1e-4 + 1e-2 + 1e-3);
  });

  it('is undefined when no output cap is known', () => {
    expect(
      ceilingOf(
        {
          inputTokens: 100,
        },
        PRICE,
      ),
    ).toBeUndefined();
  });
});

describe('createPriceBook', () => {
  function client(responses: Array<() => Promise<unknown>>): {
    client: PriceClient;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      client: frameworkCast<PriceClient>({
        models: {
          get: (req: { author: string; slug: string }) => {
            calls.push(`${req.author}/${req.slug}`);
            const next = responses.shift();
            return next ? next() : Promise.reject(new Error('none left'));
          },
        },
      }),
    };
  }

  const priced = (): Promise<unknown> =>
    Promise.resolve({
      data: {
        pricing: {
          prompt: '0.000001',
          completion: '0.00001',
          request: '0.002',
        },
        topProvider: {
          maxCompletionTokens: 4e3,
        },
        contextLength: 128e3,
      },
    });

  it('reads per-token prices and caps, and asks once per model', async () => {
    const fake = client([
      priced,
    ]);
    const price = createPriceBook(() => fake.client);

    const first = await price('acme/model');
    const second = await price('acme/model');

    expect(first).toEqual({
      input: 1e-6,
      output: 1e-5,
      request: 0.002,
      maxOutput: 4e3,
      contextLength: 128e3,
    });
    expect(second).toBe(first);
    expect(fake.calls).toEqual([
      'acme/model',
    ]);
  });

  it('does not keep a failed lookup, so the next caller asks again', async () => {
    const fake = client([
      () => Promise.reject(new Error('offline')),
      priced,
    ]);
    const price = createPriceBook(() => fake.client);

    expect(await price('acme/model')).toBeUndefined();
    await Promise.resolve();
    expect(await price('acme/model')).toBeDefined();
    expect(fake.calls).toHaveLength(2);
  });

  it('knows no price for a model id without an author, or with no client', async () => {
    const fake = client([]);
    expect(await createPriceBook(() => fake.client)('bare-model')).toBeUndefined();
    expect(await createPriceBook(() => undefined)('acme/model')).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it('knows no price when the published price is not a number', async () => {
    const fake = client([
      () =>
        Promise.resolve({
          data: {
            pricing: {
              prompt: 'n/a',
              completion: '0.00001',
            },
            topProvider: {},
            contextLength: null,
          },
        }),
    ]);
    expect(await createPriceBook(() => fake.client)('acme/model')).toBeUndefined();
  });
});
