import { describe, expect, it } from 'bun:test';
import { AgentHarness } from '../../src/harness/agent-harness';
import { chargeSpent, markSpent } from '../../src/util/spent';

const charge = {
  inputTokens: 10,
  outputTokens: 5,
  cost: 0.03,
};

function context(): ReturnType<AgentHarness['createContext']> {
  return new AgentHarness({
    name: 'spent',
    params: {},
  }).createContext();
}

describe('markSpent / chargeSpent', () => {
  it('charges what the error carries, once', () => {
    const ctx = context();
    const error = markSpent(new Error('boom'), charge);

    chargeSpent(ctx, error);
    chargeSpent(ctx, error);

    expect(ctx.cost).toBeCloseTo(0.03);
    expect(ctx.tokens.total).toBe(15);
  });

  it('wraps a thrown value that is not an object so it can carry the charge', () => {
    const ctx = context();
    const error = markSpent('boom', charge);

    expect(error).toBeInstanceOf(Error);
    chargeSpent(ctx, error);
    expect(ctx.cost).toBeCloseTo(0.03);
  });

  it('charges nothing for an unmarked error or a non-object', () => {
    const ctx = context();

    chargeSpent(ctx, new Error('boom'));
    chargeSpent(ctx, 'boom');

    expect(ctx.cost).toBe(0);
    expect(ctx.tokens.total).toBe(0);
  });

  it('leaves a thrown value alone when the call spent nothing', () => {
    expect(
      markSpent('boom', {
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe('boom');
  });

  it('adds to a charge the error already carries rather than replacing it', () => {
    const ctx = context();
    const error = markSpent(markSpent(new Error('boom'), charge), charge);

    chargeSpent(ctx, error);

    expect(ctx.cost).toBeCloseTo(0.06);
    expect(ctx.tokens.total).toBe(30);
  });
});
