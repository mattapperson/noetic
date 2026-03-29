import { describe, expect, it } from 'bun:test';
import { trackUsage } from '../../src/interpreter/message-helpers';
import type { LLMResponse } from '../../src/types/common';
import { makeMockContext } from '../_helpers';

describe('trackUsage', () => {
  function makeResponse(overrides?: Partial<LLMResponse>): LLMResponse {
    return {
      items: [],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
      cost: 0.001,
      ...overrides,
    };
  }

  it('increments tokens and cost on mutable context', () => {
    const ctx = makeMockContext();
    const response = makeResponse();

    trackUsage(ctx, response);

    expect(ctx.tokens.input).toBe(10);
    expect(ctx.tokens.output).toBe(5);
    expect(ctx.tokens.total).toBe(15);
    expect(ctx.cost).toBe(0.001);
  });

  it('accumulates across multiple calls', () => {
    const ctx = makeMockContext();

    trackUsage(ctx, makeResponse());
    trackUsage(
      ctx,
      makeResponse({
        usage: {
          inputTokens: 20,
          outputTokens: 10,
        },
        cost: 0.002,
      }),
    );

    expect(ctx.tokens.input).toBe(30);
    expect(ctx.tokens.output).toBe(15);
    expect(ctx.tokens.total).toBe(45);
    expect(ctx.cost).toBe(0.003);
  });

  it('skips cost when response has no cost', () => {
    const ctx = makeMockContext();

    trackUsage(
      ctx,
      makeResponse({
        cost: undefined,
      }),
    );

    expect(ctx.tokens.input).toBe(10);
    expect(ctx.cost).toBe(0);
  });

  it('is a no-op for frozen (non-mutable) context', () => {
    const ctx = Object.freeze({
      ...makeMockContext(),
      tokens: Object.freeze({
        input: 0,
        output: 0,
        total: 0,
      }),
    });

    // Should not throw — just silently skips
    expect(() => trackUsage(ctx, makeResponse())).not.toThrow();
  });
});
