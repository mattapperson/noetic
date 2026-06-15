import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getFlowMemoryDefaultMode, setFlowMemoryDefaultMode } from '../../src/agents/flow-state.js';
import { CODE_AGENT_DONE_SENTINEL } from '../../src/agents/shared.js';
import { doneStep } from '../../src/index.js';
import { asRunExecute, buildShortstat, createMockCheckContext } from './_helpers.js';

const runDone = asRunExecute(doneStep);

describe('doneStep', () => {
  // Tests mutate the module-level default mode; snapshot + restore so the
  // tests stay order-independent.
  let priorDefault: ReturnType<typeof getFlowMemoryDefaultMode>;
  beforeEach(() => {
    priorDefault = getFlowMemoryDefaultMode();
  });
  afterEach(() => {
    setFlowMemoryDefaultMode(priorDefault);
  });

  it('clears all four phase baselines on workflow completion', async () => {
    setFlowMemoryDefaultMode('act');
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
    // The outer wrapper reads `lastUserText` AFTER doneStep to surface the
    // assistant response to the user, so this field must survive the reset.
    expect(state.lastUserText).toBe('summary');
  });

  it('resets mode to the host-configured default so the next turn re-enters the act loop', async () => {
    // Repro for the "second submit produces no response" bug: turn 1 ends
    // with `mode: 'done'` (verify_check's PASS branch). Without this reset,
    // turn 2 routes outer→actVerifyFixWrapper→inner→INNER_MODE_ROUTES.done
    // (== doneStep), exits immediately, and no LLM call ever happens.
    setFlowMemoryDefaultMode('act');
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(0),
      flowState: {
        mode: 'done',
        lastUserText: 'previous turn text',
      },
    });
    await runDone('ignored', ctx);
    expect(getFlowState().mode).toBe('act');
  });

  it('respects a host default of plan when resetting mode', async () => {
    setFlowMemoryDefaultMode('plan');
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(0),
      flowState: {
        mode: 'done',
      },
    });
    await runDone('ignored', ctx);
    expect(getFlowState().mode).toBe('plan');
  });

  it('clears fix-loop bookkeeping (fixAttempts, lastFindingsHash, verifyFindings)', async () => {
    setFlowMemoryDefaultMode('act');
    const { ctx, getFlowState } = createMockCheckContext({
      diffShortstat: buildShortstat(0),
      flowState: {
        mode: 'done',
        fixAttempts: 2,
        lastFindingsHash: 'abc123',
        verifyFindings: 'previous findings',
      },
    });
    await runDone('ignored', ctx);
    const state = getFlowState();
    expect(state.fixAttempts).toBeUndefined();
    expect(state.lastFindingsHash).toBeUndefined();
    expect(state.verifyFindings).toBeUndefined();
  });

  it('is a no-op when state already matches the default (no persist)', async () => {
    setFlowMemoryDefaultMode('act');
    const { ctx, getStoreCallCount } = createMockCheckContext({
      diffShortstat: buildShortstat(0),
      flowState: {
        mode: 'act',
        lastUserText: 'summary',
      },
    });
    await runDone('ignored', ctx);
    expect(getStoreCallCount()).toBe(0);
  });

  it('persists when mode needs resetting even if baselines are clear', async () => {
    setFlowMemoryDefaultMode('act');
    const { ctx, getStoreCallCount } = createMockCheckContext({
      diffShortstat: buildShortstat(0),
      flowState: {
        mode: 'done',
        lastUserText: 'summary',
      },
    });
    await runDone('ignored', ctx);
    // Persistence is mandatory here: without flushing the mode reset to
    // durable storage, the next turn would re-hydrate the stale 'done' mode
    // and the bug would resurface.
    expect(getStoreCallCount()).toBe(1);
  });
});
