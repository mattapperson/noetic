import { describe, expect, it } from 'bun:test';
import { frameworkCast } from '@noetic-tools/types';
import type { PriceClient } from '../../src/harness/model-price';
import { ceilingOf, createPriceBook, measureRequest } from '../../src/harness/model-price';

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

  it('then to the context, all of which a short prompt leaves to output, plus the request price', () => {
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
    ).toBeCloseTo(1.1e-2 + 1e-3);
  });

  it('prices the longest prompt when prompt tokens cost more than output', () => {
    expect(
      ceilingOf(
        {
          inputTokens: 100,
        },
        {
          input: 1e-5,
          output: 1e-6,
          request: 0,
          contextLength: 1100,
        },
      ),
    ).toBeCloseTo(1e-3 + 1e-3);
  });

  it('never prices more prompt than the context holds', () => {
    expect(
      ceilingOf(
        {
          inputTokens: 1e4,
          maxOutputTokens: 0,
        },
        {
          ...PRICE,
          contextLength: 8e3,
        },
      ),
    ).toBeCloseTo(8e-3);
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

describe('measureRequest', () => {
  const bytes = (text: string): number => new TextEncoder().encode(text).length;

  it('bounds the prompt by its UTF-8 bytes, which no common tokenizer exceeds', () => {
    // Text a byte-level tokenizer may split into one token per byte.
    const body = {
      input: '日本語のテキスト 🧪🧪 ünïcödé '.repeat(20),
    };
    const { json, inputTokens } = measureRequest(body);
    expect(json).toBe(JSON.stringify(body));
    expect(inputTokens).toBeGreaterThanOrEqual(bytes(json));
    expect(inputTokens).toBeGreaterThan(bytes(body.input));
  });

  it('allows each media part more than its URL', () => {
    const text = measureRequest({
      input: [
        {
          type: 'input_text',
          text: 'look',
        },
      ],
    });
    const image = measureRequest({
      input: [
        {
          type: 'input_text',
          text: 'look',
        },
        {
          type: 'input_image',
          imageUrl: 'https://example.com/a.png',
        },
      ],
    });
    expect(image.inputTokens - text.inputTokens).toBeGreaterThan(2e3);
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

  it('takes the dearest price any condition charges: long prompts, cache writes, reasoning', async () => {
    const fake = client([
      () =>
        Promise.resolve({
          data: {
            pricing: {
              prompt: '0.000001',
              completion: '0.00001',
              inputCacheWrite: '0.00000125',
              inputCacheWrite1h: '0.000002',
              internalReasoning: '0.00002',
              overrides: [
                {
                  minPromptTokens: 2e5,
                  prompt: '0.000003',
                  completion: '0.00003',
                },
              ],
            },
            topProvider: {},
            contextLength: null,
          },
        }),
    ]);

    expect(await createPriceBook(() => fake.client)('acme/model')).toMatchObject({
      input: 3e-6,
      output: 3e-5,
    });
  });

  it("caps the prompt at the widest context any provider serves, not only the top one's", async () => {
    const fake = client([
      () =>
        Promise.resolve({
          data: {
            pricing: {
              prompt: '0.000001',
              completion: '0.00001',
            },
            topProvider: {
              contextLength: 2e5,
            },
            contextLength: 1e6,
          },
        }),
    ]);

    expect(await createPriceBook(() => fake.client)('acme/model')).toMatchObject({
      contextLength: 1e6,
    });
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
