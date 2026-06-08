import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { PlanState } from '../../../src/memory/layers/plan';
import { PlanPhase, planMemory } from '../../../src/memory/layers/plan';
import type { FlowNode, LlmFlowNode } from '../../../src/patterns/flow';
import { frameworkCast } from '../../../src/util/framework-cast';
import { makeCtx, makeItemLog } from '../../_helpers';

//#region Fixtures (mirror plan.test.ts)

function makeFlowNode(overrides?: Partial<LlmFlowNode>): FlowNode {
  return {
    kind: 'llm',
    id: 'leaf',
    instructions: 'Do the thing',
    ...overrides,
  };
}

function makeIdleState(overrides?: Partial<PlanState>): PlanState {
  return {
    phase: PlanPhase.Idle,
    prd: null,
    planTree: null,
    executionLog: [],
    version: 0,
    ...overrides,
  };
}

function makePlanningState(overrides?: Partial<PlanState>): PlanState {
  return {
    phase: PlanPhase.Planning,
    prd: null,
    planTree: null,
    executionLog: [],
    version: 1,
    ...overrides,
  };
}

function makeExecutingState(overrides?: Partial<PlanState>): PlanState {
  return {
    phase: PlanPhase.Executing,
    prd: '# My Plan',
    planTree: makeFlowNode(),
    executionLog: [],
    version: 1,
    ...overrides,
  };
}

function planState(value: unknown): PlanState {
  assert(value);
  return frameworkCast<PlanState>(value);
}

interface PlanStatusView {
  hasPrd: boolean;
}

//#endregion

describe('AUDIT: planMemory', () => {
  // BUG A: terminal phases (completed/failed) are a permanent dead-end.
  // After a plan completes, the only transition back to idle is exitPlanMode
  // 'cancel', which requires phase === planning. enterPlanMode requires idle.
  // So once a plan finishes, the (thread-scoped) layer can never start another.
  it('A: can start a new plan after a previous one completes', async () => {
    const layer = planMemory();
    const enter = layer.provides!.enterPlanMode;
    const updatePrd = layer.provides!.updatePrd;
    const setTree = layer.provides!.setPlanTree;
    const exit = layer.provides!.exitPlanMode;
    assert(enter.kind === 'function');
    assert(updatePrd.kind === 'function');
    assert(setTree.kind === 'function');
    assert(exit.kind === 'function');
    assert(layer.hooks.onComplete);

    // Full lifecycle: idle -> planning -> executing -> completed.
    let s = planState(
      (
        await enter.execute(
          {
            goal: 'g',
          },
          makeIdleState(),
          makeCtx(),
        )
      ).state,
    );
    s = planState(
      (
        await updatePrd.execute(
          {
            content: '# PRD',
          },
          s,
          makeCtx(),
        )
      ).state,
    );
    s = planState((await setTree.execute(makeFlowNode(), s, makeCtx())).state);
    s = planState(
      (
        await exit.execute(
          {
            action: 'execute',
          },
          s,
          makeCtx(),
        )
      ).state,
    );
    expect(s.phase).toBe(PlanPhase.Executing);
    const completed = await layer.hooks.onComplete({
      state: s,
      outcome: 'success',
      log: makeItemLog(),
      ctx: makeCtx(),
    });
    assert(completed);
    s = planState(completed.state);
    expect(s.phase).toBe(PlanPhase.Completed);

    // Now try to start a brand-new plan.
    const reentry = await enter.execute(
      {
        goal: 'next feature',
      },
      s,
      makeCtx(),
    );
    const reState = planState(reentry.state);
    expect(reState.phase).toBe(PlanPhase.Planning);
  });

  // BUG B: recall ignores the budget entirely. The recall hook destructures only
  // `{ state }` and never trims output, violating the layer contract (spec 12
  // checklist #5: "Respect the budget parameter in recall(). Trim your output to
  // fit."). A PRD even at the enforced max (50k chars) blows a 3k-token budget ~4x.
  it('B: recall respects the budget cap', async () => {
    const layer = planMemory();
    assert(layer.hooks.recall);
    const budget = 3e3;
    const result = await layer.hooks.recall({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state: makeExecutingState({
        prd: 'x'.repeat(5e4),
      }),
      budget,
    });
    assert(result !== null);
    assert(typeof result !== 'string');
    expect(result.tokenCount).toBeLessThanOrEqual(budget);
  });

  // BUG C: status.hasPrd reports true for an empty-string PRD, but exitPlanMode's
  // own check (`if (!state.prd)`) treats '' as "no PRD" and refuses to execute.
  // The two disagree about whether a PRD exists.
  it('C: status.hasPrd agrees with exitPlanMode about an empty PRD', async () => {
    const layer = planMemory();
    const updatePrd = layer.provides!.updatePrd;
    const status = layer.provides!.status;
    const exit = layer.provides!.exitPlanMode;
    assert(updatePrd.kind === 'function');
    assert(status.kind === 'data');
    assert(exit.kind === 'function');

    const afterUpdate = planState(
      (
        await updatePrd.execute(
          {
            content: '',
          },
          makePlanningState({
            planTree: makeFlowNode(),
          }),
          makeCtx(),
        )
      ).state,
    );
    const view = frameworkCast<PlanStatusView>(status.read(afterUpdate));

    const exitResult = await exit.execute(
      {
        action: 'execute',
      },
      afterUpdate,
      makeCtx(),
    );
    const exitResultText = frameworkCast<string>(exitResult.result);
    const exitAcceptedPrd = !exitResultText.includes('no PRD');

    // If status says there is a PRD, exitPlanMode must also see one.
    expect(view.hasPrd).toBe(exitAcceptedPrd);
  });

  // BUG D: recall in executing phase with a null planTree renders the literal
  // string "null" into the <active_plan> block (JSON.stringify(null)).
  it('D: recall does not emit literal "null" for a missing plan tree', async () => {
    const layer = planMemory();
    assert(layer.hooks.recall);
    const result = await layer.hooks.recall({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state: makeExecutingState({
        planTree: null,
      }),
      budget: 3e3,
    });
    assert(result !== null);
    assert(typeof result !== 'string');
    const msg = result.items[0];
    assert(msg.type === 'message');
    const part = msg.content[0];
    assert(part.type === 'input_text');
    expect(part.text).not.toContain('\nnull\n');
  });
});
