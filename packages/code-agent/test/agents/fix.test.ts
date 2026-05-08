import { describe, expect, it } from 'bun:test';
import { fixCompleteStep, preFixCaptureStep } from '../../src/agents/fix.js';
import { asRunExecute, buildShortstat, createMockCheckContext } from './_helpers.js';

const runPreFix = asRunExecute(preFixCaptureStep);
const runFixComplete = asRunExecute(fixCompleteStep);

describe('preFixCaptureStep', () => {
  it('captures the diff baseline on phase entry', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(30),
    });
    await runPreFix('instructions', ctx);
    const state = getFlowState();
    expect(state.fixBaselineLines).toBe(30);
    expect(state.fixDidMutateTools).toBe(false);
  });

  it('does not re-capture when a baseline already exists', async () => {
    const { ctx, getFlowState, getShellCalls } = createMockCheckContext({
      diffShortstat: buildShortstat(100),
      flowState: {
        fixBaselineLines: 30,
        fixDidMutateTools: true,
      },
    });
    await runPreFix('instructions', ctx);
    expect(getFlowState().fixBaselineLines).toBe(30);
    expect(getFlowState().fixDidMutateTools).toBe(true);
    expect(getShellCalls()).toHaveLength(0);
  });
});

describe('fixCompleteStep', () => {
  it('routes to done when fix produced no delta and no mutating tools (regression of unconditional verify)', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(20),
      flowState: {
        fixBaselineLines: 20,
        fixDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'Read',
        },
      ],
    });
    await runFixComplete('fix report', ctx);
    const state = getFlowState();
    expect(state.mode).toBe('done');
    expect(state.lastUserText).toBe('fix report');
  });

  it('routes to verify when fix produced a sufficient delta and a mutating tool ran', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(40),
      flowState: {
        fixBaselineLines: 20,
        fixDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'Edit',
        },
      ],
    });
    await runFixComplete('fix report', ctx);
    const state = getFlowState();
    expect(state.mode).toBe('verify');
    expect(state.fixDidMutateTools).toBe(true);
  });

  it('routes to done when delta exists but no mutating tool was used in the phase', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(40),
      flowState: {
        fixBaselineLines: 20,
        fixDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'Grep',
        },
      ],
    });
    await runFixComplete('fix report', ctx);
    expect(getFlowState().mode).toBe('done');
  });

  it('routes to verify when an earlier iteration mutated files and delta is above threshold', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(30),
      flowState: {
        fixBaselineLines: 20,
        fixDidMutateTools: true,
      },
      toolCalls: [],
    });
    await runFixComplete('fix report', ctx);
    expect(getFlowState().mode).toBe('verify');
  });

  it('treats delta at the threshold as insufficient', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(25),
      flowState: {
        fixBaselineLines: 20,
        fixDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'Edit',
        },
      ],
      params: {
        verifyThreshold: 5,
      },
    });
    await runFixComplete('fix report', ctx);
    expect(getFlowState().mode).toBe('done');
  });
});
