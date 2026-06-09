import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { PlanExecutionEntry, PlanState } from '@noetic-tools/memory';
import { PlanPhase, planMemory } from '@noetic-tools/memory';
import { frameworkCast, SteeringAction } from '@noetic-tools/types';
import type { FlowNode, LlmFlowNode, SequenceFlowNode } from '../../src/patterns/flow';
import { makeCtx, makeItemLog, makeScopedStorage } from '../_helpers';

//#region Test Fixtures

function makeLlmNode(overrides?: Partial<LlmFlowNode>): LlmFlowNode {
  return {
    kind: 'llm',
    id: 'leaf',
    instructions: 'Do the thing',
    ...overrides,
  };
}

/** Depth-0 leaf FlowNode (llm kind), used as the default planTree in fixtures. */
function makeFlowNode(overrides?: Partial<LlmFlowNode>): FlowNode {
  return makeLlmNode(overrides);
}

/** Wraps nodes in a sequence to add one level of depth. */
function makeSequence(steps: FlowNode[], id = 'seq'): SequenceFlowNode {
  return {
    kind: 'sequence',
    id,
    steps,
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
  phase: PlanPhase;
  hasPrd: boolean;
  hasPlanTree: boolean;
  version: number;
}

//#endregion

//#region Layer Metadata

describe('planMemory layer', () => {
  it('has correct id and slot', () => {
    const layer = planMemory();
    expect(layer.id).toBe('plan');
    expect(layer.slot).toBe(240);
    expect(layer.scope).toBe('thread');
  });

  it('respects custom scope config', () => {
    const layer = planMemory({
      scope: 'execution',
    });
    expect(layer.scope).toBe('execution');
  });

  //#endregion

  //#region Init Hook

  describe('init', () => {
    it('defaults to idle state', async () => {
      const layer = planMemory();
      const result = await layer.hooks.init!({
        storage: makeScopedStorage(),
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      expect(result.state.phase).toBe(PlanPhase.Idle);
      expect(result.state.prd).toBeNull();
      expect(result.state.planTree).toBeNull();
      expect(result.state.version).toBe(0);
    });

    it('loads persisted state from storage', async () => {
      const storage = makeScopedStorage();
      const saved = makePlanningState({
        prd: '# Saved PRD',
      });
      await storage.set('state', saved);

      const layer = planMemory();
      const result = await layer.hooks.init!({
        storage,
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      expect(result.state.phase).toBe(PlanPhase.Planning);
      expect(result.state.prd).toBe('# Saved PRD');
    });
  });

  //#endregion

  //#region Recall Hook

  describe('recall', () => {
    it('returns null in idle phase', async () => {
      const layer = planMemory();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makeIdleState(),
        budget: 3e3,
      });
      expect(result).toBeNull();
    });

    it('returns plan_mode block in planning phase', async () => {
      const layer = planMemory();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makePlanningState({
          prd: '# Draft',
        }),
        budget: 3e3,
      });
      assert(result !== null);
      assert(typeof result !== 'string');
      expect(result.items).toHaveLength(1);
      const msg = result.items[0];
      assert(msg.type === 'message');
      expect(msg.role).toBe('developer');
      const part = msg.content[0];
      assert(part.type === 'input_text');
      expect(part.text).toContain('<plan_mode>');
      expect(part.text).toContain('PLAN MODE');
      expect(part.text).toContain('# Draft');
    });

    it('returns active_plan block in executing phase', async () => {
      const layer = planMemory();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makeExecutingState(),
        budget: 3e3,
      });
      assert(result !== null);
      assert(typeof result !== 'string');
      const part = result.items[0];
      assert(part.type === 'message');
      const text = part.content[0];
      assert(text.type === 'input_text');
      expect(text.text).toContain('<active_plan>');
      expect(text.text).toContain('# My Plan');
    });

    it('returns plan_outcome in completed phase', async () => {
      const layer = planMemory();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: {
          phase: PlanPhase.Completed,
          prd: '# Done',
          planTree: makeFlowNode(),
          executionLog: [
            {
              timestamp: Date.now(),
              version: 1,
              outcome: 'success',
            },
          ],
          version: 1,
        },
        budget: 3e3,
      });
      assert(result !== null);
      assert(typeof result !== 'string');
      const part = result.items[0];
      assert(part.type === 'message');
      const text = part.content[0];
      assert(text.type === 'input_text');
      expect(text.text).toContain('<plan_outcome>');
      expect(text.text).toContain('success');
    });

    it('returns plan_outcome in failed phase', async () => {
      const layer = planMemory();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: {
          phase: PlanPhase.Failed,
          prd: '# Failed',
          planTree: makeFlowNode(),
          executionLog: [
            {
              timestamp: Date.now(),
              version: 1,
              outcome: 'failure',
            },
          ],
          version: 1,
        },
        budget: 3e3,
      });
      assert(result !== null);
      assert(typeof result !== 'string');
      const part = result.items[0];
      assert(part.type === 'message');
      const text = part.content[0];
      assert(text.type === 'input_text');
      expect(text.text).toContain('<plan_outcome>');
      expect(text.text).toContain('failure');
    });
  });

  //#endregion

  //#region beforeToolCall Hook (Steering)

  describe('beforeToolCall', () => {
    it('allows all tools outside plan mode', async () => {
      const layer = planMemory();
      assert(layer.hooks.beforeToolCall);
      const result = await layer.hooks.beforeToolCall({
        toolName: 'Bash',
        toolArgs: {},
        ctx: makeCtx(),
        state: makeIdleState(),
      });
      expect(result.decision.action).toBe(SteeringAction.Allow);
    });

    it('allows read-only tools in plan mode', async () => {
      const layer = planMemory();
      assert(layer.hooks.beforeToolCall);
      const readOnlyTools = [
        'Read',
        'Grep',
        'Find',
        'Ls',
      ];

      for (const toolName of readOnlyTools) {
        const result = await layer.hooks.beforeToolCall({
          toolName,
          toolArgs: {},
          ctx: makeCtx(),
          state: makePlanningState(),
        });
        expect(result.decision.action).toBe(SteeringAction.Allow);
      }
    });

    it('allows plan layer tools in plan mode', async () => {
      const layer = planMemory();
      assert(layer.hooks.beforeToolCall);
      const planTools = [
        'plan/enterPlanMode',
        'plan/updatePrd',
        'plan/setPlanTree',
        'plan/exitPlanMode',
      ];

      for (const toolName of planTools) {
        const result = await layer.hooks.beforeToolCall({
          toolName,
          toolArgs: {},
          ctx: makeCtx(),
          state: makePlanningState(),
        });
        expect(result.decision.action).toBe(SteeringAction.Allow);
      }
    });

    it('denies mutating tools in plan mode', async () => {
      const layer = planMemory();
      assert(layer.hooks.beforeToolCall);
      const deniedTools = [
        'Write',
        'Edit',
        'Bash',
      ];

      for (const toolName of deniedTools) {
        const result = await layer.hooks.beforeToolCall({
          toolName,
          toolArgs: {},
          ctx: makeCtx(),
          state: makePlanningState(),
        });
        expect(result.decision.action).toBe(SteeringAction.Deny);
        expect(result.decision.guidance).toContain(toolName);
      }
    });

    it('allows additional tools from config', async () => {
      const layer = planMemory({
        additionalAllowedTools: [
          'CustomTool',
        ],
      });
      assert(layer.hooks.beforeToolCall);
      const result = await layer.hooks.beforeToolCall({
        toolName: 'CustomTool',
        toolArgs: {},
        ctx: makeCtx(),
        state: makePlanningState(),
      });
      expect(result.decision.action).toBe(SteeringAction.Allow);
    });

    it('allows all tools in executing phase', async () => {
      const layer = planMemory();
      assert(layer.hooks.beforeToolCall);
      const result = await layer.hooks.beforeToolCall({
        toolName: 'Bash',
        toolArgs: {},
        ctx: makeCtx(),
        state: makeExecutingState(),
      });
      expect(result.decision.action).toBe(SteeringAction.Allow);
    });
  });

  //#endregion

  //#region Provides (layerFn)

  describe('enterPlanMode', () => {
    it('transitions from idle to planning', async () => {
      const layer = planMemory();
      const fn = layer.provides!.enterPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          goal: 'Build feature X',
        },
        makeIdleState(),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Planning);
      expect(state.prd).toContain('Build feature X');
      expect(state.version).toBe(1);
    });

    it('rejects if not idle', async () => {
      const layer = planMemory();
      const fn = layer.provides!.enterPlanMode;
      assert(fn.kind === 'function');
      const inputState = makePlanningState();
      const result = await fn.execute({}, inputState, makeCtx());
      expect(result.result).toContain('Cannot enter plan mode');
      expect(result.state).toBe(inputState); // Same reference returned
    });

    it('seeds PRD with goal when provided', async () => {
      const layer = planMemory();
      const fn = layer.provides!.enterPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          goal: 'Migrate to v2',
        },
        makeIdleState(),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.prd).toBe('# Goal\n\nMigrate to v2\n');
    });

    it('leaves PRD null when no goal', async () => {
      const layer = planMemory();
      const fn = layer.provides!.enterPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute({}, makeIdleState(), makeCtx());
      const state = planState(result.state);
      expect(state.prd).toBeNull();
    });
  });

  describe('updatePrd', () => {
    it('updates PRD in planning phase', async () => {
      const layer = planMemory();
      const fn = layer.provides!.updatePrd;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          content: '# Updated PRD',
        },
        makePlanningState(),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.prd).toBe('# Updated PRD');
      expect(result.result).toBe('PRD updated successfully.');
    });

    it('rejects if not in planning phase', async () => {
      const layer = planMemory();
      const fn = layer.provides!.updatePrd;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          content: '# PRD',
        },
        makeExecutingState(),
        makeCtx(),
      );
      expect(result.result).toContain('Cannot update PRD');
    });

    it('rejects if content exceeds max length', async () => {
      const layer = planMemory({
        maxPrdLength: 100,
      });
      const fn = layer.provides!.updatePrd;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          content: 'x'.repeat(101),
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('exceeds maximum length');
    });

    it('accepts content at max length boundary', async () => {
      const layer = planMemory({
        maxPrdLength: 100,
      });
      const fn = layer.provides!.updatePrd;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          content: 'x'.repeat(100),
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toBe('PRD updated successfully.');
    });

    it('accepts content below max length boundary (N-1)', async () => {
      const layer = planMemory({
        maxPrdLength: 100,
      });
      const fn = layer.provides!.updatePrd;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          content: 'x'.repeat(99),
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toBe('PRD updated successfully.');
    });
  });

  describe('setPlanTree', () => {
    it('sets plan tree in planning phase', async () => {
      const layer = planMemory();
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const node = makeFlowNode();
      const result = await fn.execute(node, makePlanningState(), makeCtx());
      const state = planState(result.state);
      expect(state.planTree).toEqual(node);
    });

    it('rejects if not in planning phase', async () => {
      const layer = planMemory();
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const result = await fn.execute(makeFlowNode(), makeExecutingState(), makeCtx());
      expect(result.result).toContain('Cannot set plan tree');
    });

    it('rejects if tree exceeds max depth', async () => {
      const layer = planMemory({
        maxTreeDepth: 1,
      });
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      // Nested sequences → depth 2, exceeds max of 1.
      const deepTree = makeSequence(
        [
          makeSequence(
            [
              makeLlmNode({
                id: 'grandchild',
              }),
            ],
            'child',
          ),
        ],
        'root',
      );
      const result = await fn.execute(deepTree, makePlanningState(), makeCtx());
      expect(result.result).toContain('exceeds maximum depth');
    });

    it('accepts tree at max depth boundary', async () => {
      const layer = planMemory({
        maxTreeDepth: 1,
      });
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      // One sequence wrapping a leaf → depth 1, at boundary.
      const shallowTree = makeSequence(
        [
          makeLlmNode({
            id: 'child',
          }),
        ],
        'root',
      );
      const result = await fn.execute(shallowTree, makePlanningState(), makeCtx());
      expect(result.result).toContain('successfully');
    });

    it('accepts tree below max depth boundary (N-1)', async () => {
      const layer = planMemory({
        maxTreeDepth: 1,
      });
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      // Bare leaf → depth 0, below boundary.
      const leafTree = makeFlowNode();
      const result = await fn.execute(leafTree, makePlanningState(), makeCtx());
      expect(result.result).toContain('successfully');
    });
  });

  describe('exitPlanMode', () => {
    it('transitions to executing when PRD and tree exist', async () => {
      const layer = planMemory();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          prd: '# PRD',
          planTree: makeFlowNode(),
        }),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Executing);
    });

    it('rejects execute without PRD', async () => {
      const layer = planMemory();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          planTree: makeFlowNode(),
        }),
        makeCtx(),
      );
      expect(result.result).toContain('no PRD');
    });

    it('rejects execute without plan tree', async () => {
      const layer = planMemory();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          prd: '# PRD',
        }),
        makeCtx(),
      );
      expect(result.result).toContain('no plan tree');
    });

    it('cancels and resets to idle', async () => {
      const layer = planMemory();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'cancel',
        },
        makePlanningState({
          prd: '# Discard me',
        }),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Idle);
      expect(state.prd).toBeNull();
      expect(state.planTree).toBeNull();
    });

    it('rejects if not in planning phase', async () => {
      const layer = planMemory();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makeExecutingState(),
        makeCtx(),
      );
      expect(result.result).toContain('Cannot exit plan mode');
    });
  });

  //#endregion

  //#region onSpawn Hook

  describe('onSpawn', () => {
    it('clones state to child', async () => {
      const layer = planMemory();
      assert(layer.hooks.onSpawn);
      const parentState = makeExecutingState();
      const result = await layer.hooks.onSpawn({
        parentState,
        childCtx: makeCtx(),
      });
      assert(result);
      expect(result.childState).toEqual(parentState);
      expect(result.childState).not.toBe(parentState); // Deep clone
    });
  });

  //#endregion

  //#region onComplete Hook

  describe('onComplete', () => {
    it('records success when executing', async () => {
      const layer = planMemory();
      assert(layer.hooks.onComplete);
      const result = await layer.hooks.onComplete({
        state: makeExecutingState(),
        outcome: 'success',
        log: makeItemLog(),
        ctx: makeCtx(),
      });
      assert(result);
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Completed);
      expect(state.executionLog).toHaveLength(1);
      expect(state.executionLog[0].outcome).toBe('success');
    });

    it('records failure when executing', async () => {
      const layer = planMemory();
      assert(layer.hooks.onComplete);
      const result = await layer.hooks.onComplete({
        state: makeExecutingState(),
        outcome: 'failure',
        log: makeItemLog(),
        ctx: makeCtx(),
      });
      assert(result);
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Failed);
      expect(state.executionLog).toHaveLength(1);
      expect(state.executionLog[0].outcome).toBe('failure');
    });

    it('records aborted outcome when executing', async () => {
      const layer = planMemory();
      assert(layer.hooks.onComplete);
      const result = await layer.hooks.onComplete({
        state: makeExecutingState(),
        outcome: 'aborted',
        log: makeItemLog(),
        ctx: makeCtx(),
      });
      assert(result);
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Failed);
      expect(state.executionLog).toHaveLength(1);
      expect(state.executionLog[0].outcome).toBe('aborted');
    });

    it('does not modify state when not executing', async () => {
      const layer = planMemory();
      assert(layer.hooks.onComplete);
      const result = await layer.hooks.onComplete({
        state: makePlanningState(),
        outcome: 'success',
        log: makeItemLog(),
        ctx: makeCtx(),
      });
      expect(result).toBeUndefined();
    });

    it('caps executionLog at max entries', async () => {
      const layer = planMemory();
      assert(layer.hooks.onComplete);
      const longLog: PlanExecutionEntry[] = Array.from(
        {
          length: 15,
        },
        (_, i): PlanExecutionEntry => ({
          timestamp: i,
          version: 1,
          outcome: 'success',
        }),
      );
      const result = await layer.hooks.onComplete({
        state: makeExecutingState({
          executionLog: longLog,
        }),
        outcome: 'success',
        log: makeItemLog(),
        ctx: makeCtx(),
      });
      assert(result);
      const state = planState(result.state);
      // 15 existing + 1 new = 16, capped to 10
      expect(state.executionLog.length).toBeLessThanOrEqual(10);
    });
  });

  //#endregion

  //#region Host Callbacks (onEnterSession, onExit, additionalPlanInstructions)

  describe('host callbacks', () => {
    it('calls onEnterSession and stores returned slug in state', async () => {
      let called = 0;
      const layer = planMemory({
        onEnterSession: async () => {
          called += 1;
          return {
            slug: 'amber-cobalt-falcon',
          };
        },
      });
      const fn = layer.provides!.enterPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute({}, makeIdleState(), makeCtx());
      const state = planState(result.state);
      expect(called).toBe(1);
      expect(state.planSlug).toBe('amber-cobalt-falcon');
    });

    it('leaves planSlug null when no callback configured', async () => {
      const layer = planMemory();
      const fn = layer.provides!.enterPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute({}, makeIdleState(), makeCtx());
      const state = planState(result.state);
      expect(state.planSlug ?? null).toBeNull();
    });

    it('rejected onExit keeps phase in Planning and reports rejection', async () => {
      const layer = planMemory({
        onExit: async () => ({
          approved: false,
        }),
      });
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const inputState = makePlanningState({
        prd: '# PRD',
        planTree: makeFlowNode(),
      });
      const result = await fn.execute(
        {
          action: 'execute',
        },
        inputState,
        makeCtx(),
      );
      expect(result.result).toContain('did not approve');
      expect(result.state).toBe(inputState);
    });

    it('approved onExit transitions to Executing', async () => {
      const layer = planMemory({
        onExit: async () => ({
          approved: true,
        }),
      });
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          prd: '# PRD',
          planTree: makeFlowNode(),
        }),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Executing);
    });

    it('appends additionalPlanInstructions to recall payload', async () => {
      const layer = planMemory({
        additionalPlanInstructions: 'PROJECT_RULE: do not touch the auth module.',
      });
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makePlanningState(),
        budget: 3e3,
      });
      assert(result !== null);
      assert(typeof result !== 'string');
      const part = result.items[0];
      assert(part.type === 'message');
      const text = part.content[0];
      assert(text.type === 'input_text');
      expect(text.text).toContain('PROJECT_RULE');
    });
  });

  //#endregion

  //#region Status Data

  describe('status layerData', () => {
    it('projects phase and flags from state', () => {
      const layer = planMemory();
      const status = layer.provides!.status;
      assert(status.kind === 'data');
      const value = frameworkCast<PlanStatusView>(
        status.read(
          makePlanningState({
            prd: '# PRD',
            planTree: makeFlowNode(),
          }),
        ),
      );
      expect(value.phase).toBe(PlanPhase.Planning);
      expect(value.hasPrd).toBe(true);
      expect(value.hasPlanTree).toBe(true);
      expect(value.version).toBe(1);
    });

    it('reports false when PRD and tree are null', () => {
      const layer = planMemory();
      const status = layer.provides!.status;
      assert(status.kind === 'data');
      const value = frameworkCast<PlanStatusView>(status.read(makePlanningState()));
      expect(value.hasPrd).toBe(false);
      expect(value.hasPlanTree).toBe(false);
    });
  });

  //#endregion
});
