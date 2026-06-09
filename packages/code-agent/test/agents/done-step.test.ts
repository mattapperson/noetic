import { describe, expect, it } from 'bun:test';
import { CODE_AGENT_DONE_SENTINEL } from '../../src/agents/shared.js';
import { doneStep } from '../../src/index.js';
import { asRunExecute, buildShortstat, createMockCheckContext } from './_helpers.js';

const runDone = asRunExecute(doneStep);

describe('doneStep', () => {
  it('clears all four phase baselines on workflow completion', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(0),
      flowState: {
        mode: 'done',
        actBaselineLines: 20,
        actDidMutateTools: true,
        fixBaselineLines: 10,
        fixDidMutateTools: false,
        lastUserText: 'summary',
      },
    });
    const result = await runDone('ignored', ctx);
    expect(result).toBe(CODE_AGENT_DONE_SENTINEL);
    const state = getFlowState();
    expect(state.actBaselineLines).toBeUndefined();
    expect(state.actDidMutateTools).toBeUndefined();
    expect(state.fixBaselineLines).toBeUndefined();
    expect(state.fixDidMutateTools).toBeUndefined();
    // Does not disturb unrelated state
    expect(state.lastUserText).toBe('summary');
  });

  it('is a no-op when baselines are already clear (no persist)', async () => {
    const { ctx, getStoreCallCount } = createMockCheckContext({
      diffShortstat: buildShortstat(0),
      flowState: {
        mode: 'done',
        lastUserText: 'summary',
      },
    });
    await runDone('ignored', ctx);
    expect(getStoreCallCount()).toBe(0);
  });
});
