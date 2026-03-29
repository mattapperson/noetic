import { describe, expect, it, mock } from 'bun:test';
import {
  aiCondition,
  allCondition,
  anyCondition,
  embeddingMatch,
  otherwise,
  semanticRoute,
  semanticSwitch,
  when,
} from '../../src/conditions';
import type { EmbedFn } from '../../src/types/embed';
import type { Step } from '../../src/types/step';
import {
  makeLLMResponse,
  makeMockContext,
  makeMockContextWithClient,
  makeStorage,
  mockEmbed,
} from '../_helpers';

//#region Mock Factories

function makeStep(id: string): Step<string, string> {
  return {
    kind: 'run',
    id,
    execute: async () => `result-${id}`,
  };
}

/** Shorthand: create a mock context with a single scripted LLM text response. */
function mockCtxWithLlm(text: string): ReturnType<typeof makeMockContext> {
  return makeMockContextWithClient([
    makeLLMResponse(text),
  ]);
}

//#endregion

describe('semanticRoute', () => {
  const ctx = makeMockContext();
  const stepA = makeStep('a');
  const stepB = makeStep('b');
  const fallback = makeStep('fallback');

  it('evaluates conditions in order and returns first match', async () => {
    const route = semanticRoute<string, string>(
      when(async () => false, stepA),
      when(async () => true, stepB),
    );
    const result = await route('input', ctx);
    expect(result).toBe(stepB);
  });

  it('falls through to otherwise', async () => {
    const route = semanticRoute<string, string>(
      when(async () => false, stepA),
      otherwise(fallback),
    );
    const result = await route('input', ctx);
    expect(result).toBe(fallback);
  });

  it('returns null with no match and no otherwise', async () => {
    const route = semanticRoute<string, string>(when(async () => false, stepA));
    const result = await route('input', ctx);
    expect(result).toBeNull();
  });
});

describe('aiCondition', () => {
  it('parses true from mock LLM', async () => {
    const ctx = mockCtxWithLlm('{"answer": true}');
    const condition = aiCondition<string>({
      model: 'test-model',
      prompt: 'Is this positive?',
    });
    const result = await condition('great day', ctx);
    expect(result).toBe(true);
  });

  it('parses false from mock LLM', async () => {
    const ctx = mockCtxWithLlm('{"answer": false}');
    const condition = aiCondition<string>({
      model: 'test-model',
      prompt: 'Is this positive?',
    });
    const result = await condition('bad day', ctx);
    expect(result).toBe(false);
  });

  it('returns false on invalid JSON', async () => {
    const ctx = mockCtxWithLlm('not json');
    const condition = aiCondition<string>({
      model: 'test-model',
      prompt: 'Is this positive?',
    });
    const result = await condition('input', ctx);
    expect(result).toBe(false);
  });
});

describe('embeddingMatch', () => {
  const ctx = makeMockContext();

  it('single label match above threshold', async () => {
    const embed = mockEmbed({
      'hello world': [
        1,
        0,
        0,
      ],
      greeting: [
        0.95,
        0.05,
        0,
      ],
    });
    const condition = embeddingMatch<string>(embed, 'greeting', 0.9);
    const result = await condition('hello world', ctx);
    expect(result).toBe(true);
  });

  it('single label reject below threshold', async () => {
    const embed = mockEmbed({
      'hello world': [
        1,
        0,
        0,
      ],
      unrelated: [
        0,
        1,
        0,
      ],
    });
    const condition = embeddingMatch<string>(embed, 'unrelated', 0.9);
    const result = await condition('hello world', ctx);
    expect(result).toBe(false);
  });

  it('multi-label any (OR) matches if any label matches', async () => {
    const embed = mockEmbed({
      input: [
        1,
        0,
        0,
      ],
      'label-a': [
        0,
        1,
        0,
      ],
      'label-b': [
        0.99,
        0.01,
        0,
      ],
    });
    const condition = embeddingMatch<string>({
      embed,
      labels: [
        'label-a',
        'label-b',
      ],
      threshold: 0.9,
      match: 'any',
    });
    const result = await condition('input', ctx);
    expect(result).toBe(true);
  });

  it('multi-label all (AND) fails if not all match', async () => {
    const embed = mockEmbed({
      input: [
        1,
        0,
        0,
      ],
      'label-a': [
        0,
        1,
        0,
      ],
      'label-b': [
        0.99,
        0.01,
        0,
      ],
    });
    const condition = embeddingMatch<string>({
      embed,
      labels: [
        'label-a',
        'label-b',
      ],
      threshold: 0.9,
      match: 'all',
    });
    const result = await condition('input', ctx);
    expect(result).toBe(false);
  });

  it('uses StorageAdapter cache for label embeddings', async () => {
    const embedCalls: string[][] = [];
    const embed: EmbedFn = async (texts) => {
      embedCalls.push([
        ...texts,
      ]);
      return texts.map(() => [
        1,
        0,
        0,
      ]);
    };

    const cache = makeStorage();
    const condition = embeddingMatch<string>({
      embed,
      labels: [
        'cached-label',
      ],
      threshold: 0.5,
      cache,
    });

    // First call — should embed the label
    await condition('input-1', ctx);
    expect(embedCalls.length).toBe(2); // one for input, one for label

    // Second call — label should come from cache
    embedCalls.length = 0;
    await condition('input-2', ctx);
    expect(embedCalls.length).toBe(1); // only the input
  });
});

describe('semanticSwitch', () => {
  const ctx = makeMockContext();
  const stepGreeting = makeStep('greeting');
  const stepQuestion = makeStep('question');
  const stepDefault = makeStep('default');

  it('single-label case matches best', async () => {
    const embed = mockEmbed({
      'hi there': [
        1,
        0,
        0,
      ],
      greeting: [
        0.95,
        0.05,
        0,
      ],
      question: [
        0,
        1,
        0,
      ],
    });
    const route = semanticSwitch<string, string>({
      embed,
      cases: {
        greeting: stepGreeting,
        question: stepQuestion,
      },
      threshold: 0.7,
    });
    const result = await route('hi there', ctx);
    expect(result).toBe(stepGreeting);
  });

  it('falls to default when no match above threshold', async () => {
    const embed = mockEmbed({
      'random input': [
        0,
        0,
        1,
      ],
      greeting: [
        1,
        0,
        0,
      ],
      question: [
        0,
        1,
        0,
      ],
    });
    const route = semanticSwitch<string, string>({
      embed,
      cases: {
        greeting: stepGreeting,
        question: stepQuestion,
      },
      default: stepDefault,
      threshold: 0.7,
    });
    const result = await route('random input', ctx);
    expect(result).toBe(stepDefault);
  });

  it('returns null when no match and no default', async () => {
    const embed = mockEmbed({
      'random input': [
        0,
        0,
        1,
      ],
      greeting: [
        1,
        0,
        0,
      ],
    });
    const route = semanticSwitch<string, string>({
      embed,
      cases: {
        greeting: stepGreeting,
      },
      threshold: 0.7,
    });
    const result = await route('random input', ctx);
    expect(result).toBeNull();
  });

  it('multi-label case matches any label', async () => {
    const embed = mockEmbed({
      'yo!': [
        1,
        0,
        0,
      ],
      hello: [
        0,
        1,
        0,
      ],
      hi: [
        0.95,
        0.05,
        0,
      ],
    });
    const route = semanticSwitch<string, string>({
      embed,
      cases: [
        {
          labels: [
            'hello',
            'hi',
          ],
          step: stepGreeting,
        },
      ],
      threshold: 0.7,
    });
    const result = await route('yo!', ctx);
    expect(result).toBe(stepGreeting);
  });

  it('caches label embeddings with StorageAdapter', async () => {
    const embedCalls: string[][] = [];
    const embed: EmbedFn = async (texts) => {
      embedCalls.push([
        ...texts,
      ]);
      return texts.map(() => [
        1,
        0,
        0,
      ]);
    };

    const cache = makeStorage();
    const route = semanticSwitch<string, string>({
      embed,
      cases: {
        greeting: stepGreeting,
      },
      threshold: 0.5,
      cache,
    });

    // First call — embeds input + label
    await route('input-1', ctx);
    const firstCallCount = embedCalls.length;

    // Second call — label comes from cache, only input is embedded
    embedCalls.length = 0;
    await route('input-2', ctx);
    // Should only have 1 call (for the input), not 2
    expect(embedCalls.length).toBe(1);
    expect(firstCallCount).toBeGreaterThanOrEqual(1);
  });
});

describe('anyCondition', () => {
  const ctx = makeMockContext();

  it('true when any sub-condition is true', async () => {
    const condition = anyCondition<string>(
      async () => false,
      async () => true,
    );
    expect(await condition('input', ctx)).toBe(true);
  });

  it('false when all sub-conditions are false', async () => {
    const condition = anyCondition<string>(
      async () => false,
      async () => false,
    );
    expect(await condition('input', ctx)).toBe(false);
  });

  it('short-circuits on first true', async () => {
    const secondCalled = mock(async () => true);
    const condition = anyCondition<string>(async () => true, secondCalled);
    await condition('input', ctx);
    expect(secondCalled).not.toHaveBeenCalled();
  });
});

describe('allCondition', () => {
  const ctx = makeMockContext();

  it('true when all sub-conditions are true', async () => {
    const condition = allCondition<string>(
      async () => true,
      async () => true,
    );
    expect(await condition('input', ctx)).toBe(true);
  });

  it('false when any sub-condition is false', async () => {
    const condition = allCondition<string>(
      async () => true,
      async () => false,
    );
    expect(await condition('input', ctx)).toBe(false);
  });

  it('short-circuits on first false', async () => {
    const secondCalled = mock(async () => true);
    const condition = allCondition<string>(async () => false, secondCalled);
    await condition('input', ctx);
    expect(secondCalled).not.toHaveBeenCalled();
  });
});
