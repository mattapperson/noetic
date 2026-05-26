import { describe, expect, it } from 'bun:test';
import { postActCheckStep, preActCaptureStep } from '../../src/agents/act.js';
import { asRunExecute, buildShortstat, createMockCheckContext } from './_helpers.js';

const runPreAct = asRunExecute(preActCaptureStep);
const runPostAct = asRunExecute(postActCheckStep);

describe('preActCaptureStep', () => {
  it('captures the current diff line count when no baseline is set', async () => {
    const { ctx, getFlowState, getStoreCallCount } = createMockCheckContext({
      diffShortstat: buildShortstat(20),
    });
    const result = await runPreAct('instructions', ctx);
    expect(result).toBe('instructions');
    const state = getFlowState();
    expect(state.actBaselineLines).toBe(20);
    expect(state.actDidMutateTools).toBe(false);
    expect(getStoreCallCount()).toBe(1);
  });

  it('is idempotent when a baseline already exists', async () => {
    const { ctx, getFlowState, getStoreCallCount, getShellCalls } = createMockCheckContext({
      diffShortstat: buildShortstat(50),
      flowState: {
        actBaselineLines: 20,
        actDidMutateTools: true,
      },
    });
    await runPreAct('instructions', ctx);
    const state = getFlowState();
    expect(state.actBaselineLines).toBe(20);
    expect(state.actDidMutateTools).toBe(true);
    expect(getStoreCallCount()).toBe(0);
    expect(getShellCalls()).toHaveLength(0);
  });
});

describe('postActCheckStep', () => {
  it('routes to done when the diff delta is zero on a pre-dirty tree (the reported bug)', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(20),
      flowState: {
        actBaselineLines: 20,
        actDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'Read',
        },
      ],
    });
    await runPostAct('summary', ctx);
    const state = getFlowState();
    expect(state.mode).toBe('done');
    expect(state.lastUserText).toBe('summary');
  });

  it('routes to verify when delta exceeds threshold AND a mutating tool ran', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(35),
      flowState: {
        actBaselineLines: 20,
        actDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'Edit',
        },
      ],
    });
    await runPostAct('summary', ctx);
    const state = getFlowState();
    expect(state.mode).toBe('verify');
    expect(state.actDidMutateTools).toBe(true);
    expect(state.lastUserText).toBe('summary');
  });

  it('routes to verify on a clean tree when a mutating tool produced a delta', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(10),
      flowState: {
        actBaselineLines: 0,
        actDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'Write',
        },
      ],
    });
    await runPostAct('summary', ctx);
    expect(getFlowState().mode).toBe('verify');
  });

  it('routes to done when delta exists but only read-only tools ran (AND-gate is real)', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(10),
      flowState: {
        actBaselineLines: 0,
        actDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'Read',
        },
      ],
    });
    await runPostAct('summary', ctx);
    expect(getFlowState().mode).toBe('done');
  });

  it('preserves mutation evidence from earlier iterations when the current iteration called no tools', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(10),
      flowState: {
        actBaselineLines: 0,
        actDidMutateTools: true,
      },
      toolCalls: [],
    });
    await runPostAct('summary', ctx);
    const state = getFlowState();
    expect(state.mode).toBe('verify');
    expect(state.actDidMutateTools).toBe(true);
  });

  it('treats delta equal to threshold as below (strict >)', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(5),
      flowState: {
        actBaselineLines: 0,
        actDidMutateTools: false,
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
    await runPostAct('summary', ctx);
    expect(getFlowState().mode).toBe('done');
  });

  it('treats delta one above threshold as sufficient', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(6),
      flowState: {
        actBaselineLines: 0,
        actDidMutateTools: false,
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
    await runPostAct('summary', ctx);
    expect(getFlowState().mode).toBe('verify');
  });

  it('counts the `agent` tool (sub-agent delegation) as mutating', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(10),
      flowState: {
        actBaselineLines: 0,
        actDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'agent',
        },
      ],
    });
    await runPostAct('summary', ctx);
    expect(getFlowState().mode).toBe('verify');
  });

  it('counts InteractiveTerminal as mutating', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(10),
      flowState: {
        actBaselineLines: 0,
        actDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'InteractiveTerminal',
        },
      ],
    });
    await runPostAct('summary', ctx);
    expect(getFlowState().mode).toBe('verify');
  });

  it('issues git diff HEAD --shortstat so staged changes count', async () => {
    const { ctx, getShellCalls } = createMockCheckContext({
      diffShortstat: buildShortstat(10),
      flowState: {
        actBaselineLines: 0,
        actDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'Edit',
        },
      ],
    });
    await runPostAct('summary', ctx);
    const diffCalls = getShellCalls().filter((c) => c.command.includes('git diff'));
    expect(diffCalls).toHaveLength(1);
    expect(diffCalls[0].command).toBe('git diff HEAD --shortstat');
  });

  it('respects a custom verifyThreshold param', async () => {
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(30),
      flowState: {
        actBaselineLines: 0,
        actDidMutateTools: false,
      },
      toolCalls: [
        {
          name: 'Edit',
        },
      ],
      params: {
        verifyThreshold: 50,
      },
    });
    await runPostAct('summary', ctx);
    expect(getFlowState().mode).toBe('done');
  });
});
