import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { PlanExecutionEntry, PlanState } from '@noetic-tools/context';
import { PlanPhase, PlanStyle, planContext } from '@noetic-tools/context';
import type {
  CallModelWorkflowNode,
  ContextLayer,
  SequenceWorkflowNode,
  SubflowWorkflowNode,
  WorkflowDocument,
  WorkflowNode,
} from '@noetic-tools/types';
import { frameworkCast, SteeringAction } from '@noetic-tools/types';
import { makeCtx, makeItemLog, makeScopedStorage } from '../_helpers';

//#region Test Fixtures

function makeLlmNode(overrides?: Partial<CallModelWorkflowNode>): CallModelWorkflowNode {
  return {
    kind: 'callModel',
    id: 'leaf',
    instructions: 'Do the thing',
    ...overrides,
  };
}

type RecallResult = Awaited<ReturnType<NonNullable<ContextLayer<PlanState>['hooks']['recall']>>>;

/** Pulls the rendered text out of a recall result. */
function recallText(result: RecallResult): string {
  assert(result !== null);
  assert(typeof result !== 'string');
  const msg = result.items[0];
  assert(msg?.type === 'message');
  const part = msg.content[0];
  assert(part?.type === 'input_text');
  return part.text;
}

/** Wraps a root node in the document envelope. Defaults to a depth-0 llm leaf. */
function makeDoc(root: WorkflowNode = makeLlmNode()): WorkflowDocument {
  return {
    version: 1,
    root,
  };
}

/** Wraps nodes in a sequence to add one level of depth. */
function makeSequence(steps: WorkflowNode[], id = 'seq'): SequenceWorkflowNode {
  return {
    kind: 'sequence',
    id,
    steps,
  };
}

function makeSubflow(ref: string, id = `sub-${ref}`): SubflowWorkflowNode {
  return {
    kind: 'subflow',
    id,
    ref,
  };
}

function makePlanningState(overrides?: Partial<PlanState>): PlanState {
  return {
    phase: PlanPhase.Planning,
    prd: null,
    planTree: null,
    workflows: {},
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
    workflows: {},
    executionLog: [],
    version: 0,
    ...overrides,
  };
}

function makeExecutingState(overrides?: Partial<PlanState>): PlanState {
  return {
    phase: PlanPhase.Executing,
    prd: '# My Plan',
    planTree: makeDoc(),
    workflows: {},
    executionLog: [],
    version: 1,
    ...overrides,
  };
}

function makeCompletedState(overrides?: Partial<PlanState>): PlanState {
  return {
    ...makeExecutingState(),
    phase: PlanPhase.Completed,
    executionLog: [
      {
        timestamp: 0,
        version: 1,
        outcome: 'success',
      },
    ],
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
  workflowNames: string[];
  version: number;
}

//#endregion

//#region Layer Metadata

describe('planContext layer', () => {
  it('has correct id and slot', () => {
    const layer = planContext();
    expect(layer.id).toBe('plan');
    expect(layer.slot).toBe(240);
    expect(layer.scope).toBe('thread');
  });

  it('respects custom scope config', () => {
    const layer = planContext({
      scope: 'execution',
    });
    expect(layer.scope).toBe('execution');
  });

  //#endregion

  //#region Init Hook

  describe('init', () => {
    it('defaults to idle state', async () => {
      const layer = planContext();
      const result = await layer.hooks.init!({
        storage: makeScopedStorage(),
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      expect(result.state.phase).toBe(PlanPhase.Idle);
      expect(result.state.prd).toBeNull();
      expect(result.state.planTree).toBeNull();
      expect(result.state.workflows).toEqual({});
      expect(result.state.version).toBe(0);
    });

    it('loads persisted state from storage', async () => {
      const storage = makeScopedStorage();
      const saved = makePlanningState({
        prd: '# Saved PRD',
        planTree: makeDoc(),
      });
      await storage.set('state', saved);

      const layer = planContext();
      const result = await layer.hooks.init!({
        storage,
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      expect(result.state.phase).toBe(PlanPhase.Planning);
      expect(result.state.prd).toBe('# Saved PRD');
      expect(result.state.planTree).toEqual(makeDoc());
    });

    it('resets a legacy (non-WorkflowDocument) plan tree to null and backfills workflows', async () => {
      const storage = makeScopedStorage();
      // Legacy FlowNode shape: a bare node with no document envelope, and no
      // workflows map — the pre-WorkflowDocument state format.
      const legacy = {
        phase: PlanPhase.Planning,
        prd: '# Old PRD',
        planTree: {
          kind: 'callModel',
          id: 'leaf',
          instructions: 'old shape',
        },
        executionLog: [],
        version: 2,
      };
      await storage.set('state', legacy);

      const layer = planContext();
      const result = await layer.hooks.init!({
        storage,
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      expect(result.state.phase).toBe(PlanPhase.Planning);
      expect(result.state.prd).toBe('# Old PRD');
      expect(result.state.planTree).toBeNull();
      expect(result.state.workflows).toEqual({});
      expect(result.state.version).toBe(2);
    });

    it('drops malformed persisted workflows and keeps valid ones', async () => {
      const storage = makeScopedStorage();
      const good = makeDoc();
      await storage.set('state', {
        ...makePlanningState(),
        workflows: {
          good,
          broken: {
            nope: true,
          },
        },
      });

      const layer = planContext();
      const result = await layer.hooks.init!({
        storage,
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      expect(result.state.workflows).toEqual({
        good,
      });

      // Recall must survive: a malformed entry previously crashed walkWorkflow.
      const recall = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: result.state,
        budget: 3e3,
      });
      expect(recall).not.toBeNull();
    });
  });

  //#endregion

  //#region Recall Hook

  describe('recall', () => {
    it('returns null in idle phase', async () => {
      const layer = planContext();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makeIdleState(),
        budget: 3e3,
      });
      expect(result).toBeNull();
    });

    it('returns plan_mode block with workflow vocabulary in planning phase', async () => {
      const layer = planContext();
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
      expect(part.text).toContain('noetic-workflow.schema.json');
      expect(part.text).toContain('subflow');
      expect(part.text).toContain('plan/setWorkflow');
    });

    it('lists named workflows as summaries, not bodies, in planning recall', async () => {
      const layer = planContext();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makePlanningState({
          workflows: {
            verify: makeDoc(
              makeSequence([
                makeLlmNode({
                  id: 'a',
                }),
                makeLlmNode({
                  id: 'b',
                  instructions: 'MARKER_INSTRUCTIONS_BODY',
                }),
              ]),
            ),
          },
        }),
        budget: 3e3,
      });
      assert(result !== null);
      assert(typeof result !== 'string');
      const part = result.items[0];
      assert(part.type === 'message');
      const text = part.content[0];
      assert(text.type === 'input_text');
      expect(text.text).toContain('## Named workflows');
      expect(text.text).toContain('- verify: 3 nodes');
      expect(text.text).toContain('plan/getWorkflow');
      expect(text.text).not.toContain('MARKER_INSTRUCTIONS_BODY');
    });

    it('returns active_plan block with workflow names in executing phase', async () => {
      const layer = planContext();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makeExecutingState({
          workflows: {
            verify: makeDoc(),
          },
        }),
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
      expect(text.text).toContain('- verify: 1 node');
    });

    it('returns plan_outcome in completed phase', async () => {
      const layer = planContext();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: {
          phase: PlanPhase.Completed,
          prd: '# Done',
          planTree: makeDoc(),
          workflows: {},
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
      const layer = planContext();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: {
          phase: PlanPhase.Failed,
          prd: '# Failed',
          planTree: makeDoc(),
          workflows: {},
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

    it('renders the phased briefing by default and the interview loop on request', async () => {
      const args = {
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makePlanningState(),
        budget: 3e3,
      };

      const phased = recallText(await planContext().hooks.recall!(args));
      const interview = recallText(
        await planContext({
          style: PlanStyle.Interview,
        }).hooks.recall!(args),
      );

      expect(phased).toContain('### 1. Understand');
      expect(phased).not.toContain('pair-planning');
      expect(interview).toContain('pair-planning');
      expect(interview).not.toContain('### 1. Understand');
      // Whichever style runs, the model must still be told what it may call,
      // what the actions are, and how the turn ends.
      for (const text of [
        phased,
        interview,
      ]) {
        expect(text).toContain('## What you may use');
        expect(text).toContain('## Actions');
        expect(text).toContain('plan/exitPlanMode');
        expect(text).toContain('## Ending your turn');
      }
    });

    it('names the tools the host actually allows, not a fixed list', async () => {
      const text = recallText(
        await planContext({
          additionalAllowedTools: [
            'Bash',
          ],
        }).hooks.recall!({
          log: makeItemLog(),
          query: '',
          ctx: makeCtx(),
          state: makePlanningState(),
          budget: 3e3,
        }),
      );

      expect(text).toContain('Bash');
    });

    it('withholds sub-agent guidance until a host names a sub-agent tool', async () => {
      const args = {
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makePlanningState(),
        budget: 3e3,
      };

      const bare = recallText(await planContext().hooks.recall!(args));
      const withTool = recallText(
        await planContext({
          subAgentTool: 'agent',
        }).hooks.recall!(args),
      );

      // The layer ships no sub-agent tool, so the default briefing must not
      // send the model chasing one.
      expect(bare).not.toContain('sub-agent');
      expect(bare).not.toContain('parallel');
      expect(withTool).toContain('`agent`');
      expect(withTool).toContain('Critical Files for Implementation');
    });

    it('advertises only the node kinds the plan may actually use', async () => {
      const layer = planContext({
        allowedNodeKinds: [
          'callModel',
          'sequence',
          'subflow',
        ],
      });
      const text = recallText(
        await layer.hooks.recall!({
          log: makeItemLog(),
          query: '',
          ctx: makeCtx(),
          state: makePlanningState(),
          budget: 3e3,
        }),
      );

      expect(text).toContain('`callModel`');
      expect(text).toContain('restricted to the kinds');
      expect(text).not.toContain('`inParallel`');
      expect(text).not.toContain('`runCode`');
      // The tool description is built from the same table, so the two agree.
      const setPlanTree = layer.provides!.setPlanTree;
      assert(setPlanTree.kind === 'function');
      expect(setPlanTree.description).toContain('callModel, sequence, subflow');
      expect(setPlanTree.description).not.toContain('inParallel');
    });

    it('trims the fattest state dump to the headroom rather than discarding it', async () => {
      const result = await planContext().hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makePlanningState({
          prd: `# Draft\n${'x'.repeat(4e4)}`,
          planTree: makeDoc(),
        }),
        budget: 3e3,
      });
      assert(result !== null);
      assert(typeof result !== 'string');
      const text = recallText(result);

      expect(text).toContain('## Ending your turn');
      expect(text).toContain('## Current plan tree');
      expect(text).toContain('</plan_mode>');
      // The draft survives in truncated form — dropping it whole would waste
      // most of the budget on blank space.
      expect(text).toContain('# Draft');
      expect(text).toContain('trimmed to fit');
      expect(result.tokenCount).toBeLessThanOrEqual(3e3);
    });

    it('falls back to a compact briefing at the layer budget floor, and to nothing below it', async () => {
      const layer = planContext();
      const args = {
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: makePlanningState(),
      };

      // The layer declares min 100; the briefing must stay coherent there.
      const floor = await layer.hooks.recall!({
        ...args,
        budget: 100,
      });
      assert(floor !== null);
      assert(typeof floor !== 'string');
      const text = recallText(floor);
      expect(floor.tokenCount).toBeLessThanOrEqual(100);
      expect(text).toContain('<plan_mode>');
      expect(text).toContain('</plan_mode>');
      expect(text).toContain('plan/exitPlanMode');
      expect(text).toContain('read-only');

      // Below the floor a fragment of a rule is worse than silence.
      for (const budget of [
        0,
        1,
        50,
      ]) {
        expect(
          await layer.hooks.recall!({
            ...args,
            budget,
          }),
        ).toBeNull();
      }
    });

    it('keeps every phase inside its budget', async () => {
      const layer = planContext();
      const states = [
        makePlanningState({
          prd: 'p'.repeat(3e4),
          planTree: makeDoc(),
        }),
        makeExecutingState({
          prd: 'p'.repeat(3e4),
        }),
        makeCompletedState(),
      ];

      for (const state of states) {
        for (const budget of [
          0,
          1,
          99,
          100,
          101,
          3e3,
        ]) {
          const result = await layer.hooks.recall!({
            log: makeItemLog(),
            query: '',
            ctx: makeCtx(),
            state,
            budget,
          });
          if (result === null) {
            continue;
          }
          assert(typeof result !== 'string');
          expect(result.tokenCount).toBeLessThanOrEqual(budget);
        }
      }
    });
  });

  //#endregion

  //#region beforeToolCall Hook (Steering)

  describe('beforeToolCall', () => {
    it('allows all tools outside plan mode', async () => {
      const layer = planContext();
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
      const layer = planContext();
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
      const layer = planContext();
      assert(layer.hooks.beforeToolCall);
      const planTools = [
        'plan/enterPlanMode',
        'plan/updatePrd',
        'plan/setPlanTree',
        'plan/setWorkflow',
        'plan/removeWorkflow',
        'plan/getWorkflow',
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
      const layer = planContext();
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
      const layer = planContext({
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
      const layer = planContext();
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
      const layer = planContext();
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
      const layer = planContext();
      const fn = layer.provides!.enterPlanMode;
      assert(fn.kind === 'function');
      const inputState = makePlanningState();
      const result = await fn.execute({}, inputState, makeCtx());
      expect(result.result).toContain('Cannot enter plan mode');
      expect(result.state).toBe(inputState); // Same reference returned
    });

    it('seeds PRD with goal when provided', async () => {
      const layer = planContext();
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

    it('resets workflows from a previous plan', async () => {
      const layer = planContext();
      const fn = layer.provides!.enterPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {},
        makeIdleState({
          workflows: {
            stale: makeDoc(),
          },
        }),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.workflows).toEqual({});
    });

    it('leaves PRD null when no goal', async () => {
      const layer = planContext();
      const fn = layer.provides!.enterPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute({}, makeIdleState(), makeCtx());
      const state = planState(result.state);
      expect(state.prd).toBeNull();
    });
  });

  describe('updatePrd', () => {
    it('updates PRD in planning phase', async () => {
      const layer = planContext();
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
      const layer = planContext();
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
      const layer = planContext({
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
      const layer = planContext({
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
      const layer = planContext({
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
    it('sets a workflow document in planning phase', async () => {
      const layer = planContext();
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const doc = makeDoc();
      const result = await fn.execute(
        {
          document: doc,
        },
        makePlanningState(),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.planTree).toEqual(doc);
      expect(result.result).toContain('successfully');
    });

    it('accepts a JSON-stringified document', async () => {
      const layer = planContext();
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const doc = makeDoc();
      const result = await fn.execute(
        {
          document: JSON.stringify(doc),
        },
        makePlanningState(),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.planTree).toEqual(doc);
    });

    it('rejects a document that fails schema validation', async () => {
      const layer = planContext();
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          document: {
            version: 1,
            root: {
              kind: 'callModel',
              id: 'no-instructions',
            },
          },
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('Cannot set plan tree');
      expect(planState(result.state).planTree).toBeNull();
    });

    it('rejects a value that is not valid JSON', async () => {
      const layer = planContext();
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          document: '{not json',
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('not valid JSON');
    });

    it('rejects if not in planning phase', async () => {
      const layer = planContext();
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          document: makeDoc(),
        },
        makeExecutingState(),
        makeCtx(),
      );
      expect(result.result).toContain('Cannot set plan tree');
    });

    it('rejects if tree exceeds max depth', async () => {
      const layer = planContext({
        maxDepth: 1,
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
      const result = await fn.execute(
        {
          document: makeDoc(deepTree),
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('exceeds maximum depth');
    });

    it('accepts tree at max depth boundary', async () => {
      const layer = planContext({
        maxDepth: 1,
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
      const result = await fn.execute(
        {
          document: makeDoc(shallowTree),
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('successfully');
    });

    it('accepts tree below max depth boundary (N-1)', async () => {
      const layer = planContext({
        maxDepth: 1,
      });
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          document: makeDoc(),
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('successfully');
    });

    it('rejects node kinds outside allowedNodeKinds', async () => {
      const layer = planContext({
        allowedNodeKinds: [
          'sequence',
          'callModel',
          'subflow',
        ],
      });
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          document: makeDoc(
            makeSequence([
              {
                kind: 'invokeTool',
                id: 'forbidden',
                toolName: 'search',
              },
            ]),
          ),
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('disallowed node kinds: invokeTool');
    });

    it('rejects subflow refs that are not valid workflow names', async () => {
      const layer = planContext();
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          document: makeDoc(makeSubflow('Bad Name', 'sub-bad')),
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('not valid workflow names');
    });

    it('lists not-yet-defined subflow refs in the success message', async () => {
      const layer = planContext();
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          document: makeDoc(
            makeSequence([
              makeSubflow('gather-context'),
              makeSubflow('run-tests'),
            ]),
          ),
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('not yet defined');
      expect(result.result).toContain('gather-context');
      expect(result.result).toContain('run-tests');
      const state = planState(result.state);
      expect(state.planTree).not.toBeNull();
    });

    it('reports plain success when every ref is defined', async () => {
      const layer = planContext();
      const fn = layer.provides!.setPlanTree;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          document: makeDoc(makeSubflow('verify')),
        },
        makePlanningState({
          workflows: {
            verify: makeDoc(),
          },
        }),
        makeCtx(),
      );
      expect(result.result).toBe(
        'Plan tree set successfully. Call plan/exitPlanMode to request approval.',
      );
    });
  });

  describe('setWorkflow', () => {
    it('creates a named workflow', async () => {
      const layer = planContext();
      const fn = layer.provides!.setWorkflow;
      assert(fn.kind === 'function');
      const doc = makeDoc();
      const result = await fn.execute(
        {
          name: 'run-tests',
          document: doc,
        },
        makePlanningState(),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.workflows['run-tests']).toEqual(doc);
      expect(result.result).toContain('created');
    });

    it('replaces an existing name (upsert)', async () => {
      const layer = planContext();
      const fn = layer.provides!.setWorkflow;
      assert(fn.kind === 'function');
      const updated = makeDoc(
        makeLlmNode({
          instructions: 'v2',
        }),
      );
      const result = await fn.execute(
        {
          name: 'run-tests',
          document: updated,
        },
        makePlanningState({
          workflows: {
            'run-tests': makeDoc(),
          },
        }),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.workflows['run-tests']).toEqual(updated);
      expect(result.result).toContain('replaced previous version');
    });

    it('rejects if not in planning phase', async () => {
      const layer = planContext();
      const fn = layer.provides!.setWorkflow;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          name: 'run-tests',
          document: makeDoc(),
        },
        makeExecutingState(),
        makeCtx(),
      );
      expect(result.result).toContain('Cannot set workflow');
    });

    it('rejects invalid names and accepts slug boundaries', async () => {
      const layer = planContext();
      const fn = layer.provides!.setWorkflow;
      assert(fn.kind === 'function');
      const invalid = [
        'Foo',
        'has space',
        '-leading-dash',
        'a'.repeat(65),
      ];
      for (const name of invalid) {
        const result = await fn.execute(
          {
            name,
            document: makeDoc(),
          },
          makePlanningState(),
          makeCtx(),
        );
        expect(result.result).toContain('not a valid name');
      }
      const valid = [
        'a',
        'run-tests_2',
        'a'.repeat(64),
      ];
      for (const name of valid) {
        const result = await fn.execute(
          {
            name,
            document: makeDoc(),
          },
          makePlanningState(),
          makeCtx(),
        );
        expect(result.result).toContain('created');
      }
    });

    it('enforces the workflow count cap, allowing replacement at the cap', async () => {
      const layer = planContext({
        maxWorkflows: 2,
      });
      const fn = layer.provides!.setWorkflow;
      assert(fn.kind === 'function');

      // 1 stored + add new → ok (N-1).
      const one = makePlanningState({
        workflows: {
          a: makeDoc(),
        },
      });
      const addSecond = await fn.execute(
        {
          name: 'b',
          document: makeDoc(),
        },
        one,
        makeCtx(),
      );
      expect(addSecond.result).toContain('created');

      // 2 stored + add new → rejected (N).
      const two = planState(addSecond.state);
      const addThird = await fn.execute(
        {
          name: 'c',
          document: makeDoc(),
        },
        two,
        makeCtx(),
      );
      expect(addThird.result).toContain('already has 2 workflows');

      // 2 stored + replace existing → ok.
      const replace = await fn.execute(
        {
          name: 'a',
          document: makeDoc(),
        },
        two,
        makeCtx(),
      );
      expect(replace.result).toContain('replaced previous version');
    });

    it('enforces the serialized size cap at the boundary', async () => {
      const base = makeDoc();
      const baseLength = JSON.stringify(base).length;
      const layer = planContext({
        maxWorkflowChars: baseLength,
      });
      const fn = layer.provides!.setWorkflow;
      assert(fn.kind === 'function');

      // Exactly at the cap (N) → ok.
      const atCap = await fn.execute(
        {
          name: 'at-cap',
          document: base,
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(atCap.result).toContain('created');

      // One char over (N+1) → rejected.
      const over = makeDoc(
        makeLlmNode({
          instructions: `${makeLlmNode().instructions}x`,
        }),
      );
      const overCap = await fn.execute(
        {
          name: 'over-cap',
          document: over,
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(overCap.result).toContain('over the');

      // One char under the cap (N-1) → ok.
      const roomy = planContext({
        maxWorkflowChars: baseLength + 1,
      });
      const roomyFn = roomy.provides!.setWorkflow;
      assert(roomyFn.kind === 'function');
      const underCap = await roomyFn.execute(
        {
          name: 'under-cap',
          document: base,
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(underCap.result).toContain('created');
    });

    it('rejects workflows deeper than maxDepth', async () => {
      const layer = planContext({
        maxDepth: 1,
      });
      const fn = layer.provides!.setWorkflow;
      assert(fn.kind === 'function');
      const deep = makeSequence(
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
      const result = await fn.execute(
        {
          name: 'too-deep',
          document: makeDoc(deep),
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('exceeds maximum depth');
    });

    it('rejects documents that fail schema validation', async () => {
      const layer = planContext();
      const fn = layer.provides!.setWorkflow;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          name: 'bad',
          document: {
            version: 1,
            root: {
              kind: 'nope',
              id: 'x',
            },
          },
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('Cannot set workflow "bad"');
    });
  });

  describe('removeWorkflow', () => {
    it('removes a stored workflow', async () => {
      const layer = planContext();
      const fn = layer.provides!.removeWorkflow;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          name: 'a',
        },
        makePlanningState({
          workflows: {
            a: makeDoc(),
          },
        }),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.workflows).toEqual({});
      expect(result.result).toBe('Workflow "a" removed.');
    });

    it('reports unknown names with the existing list', async () => {
      const layer = planContext();
      const fn = layer.provides!.removeWorkflow;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          name: 'missing',
        },
        makePlanningState({
          workflows: {
            a: makeDoc(),
          },
        }),
        makeCtx(),
      );
      expect(result.result).toContain('No workflow named "missing"');
      expect(result.result).toContain('a');
    });

    it('warns when the removed workflow is still referenced', async () => {
      const layer = planContext();
      const fn = layer.provides!.removeWorkflow;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          name: 'verify',
        },
        makePlanningState({
          planTree: makeDoc(makeSubflow('verify')),
          workflows: {
            verify: makeDoc(),
          },
        }),
        makeCtx(),
      );
      expect(result.result).toContain('removed');
      expect(result.result).toContain('still referenced');
    });
  });

  describe('getWorkflow', () => {
    it('round-trips a stored workflow as pretty JSON', async () => {
      const layer = planContext();
      const fn = layer.provides!.getWorkflow;
      assert(fn.kind === 'function');
      const doc = makeDoc();
      const result = await fn.execute(
        {
          name: 'a',
        },
        makePlanningState({
          workflows: {
            a: doc,
          },
        }),
        makeCtx(),
      );
      expect(JSON.parse(frameworkCast<string>(result.result))).toEqual(doc);
    });

    it('reports unknown names with the existing list', async () => {
      const layer = planContext();
      const fn = layer.provides!.getWorkflow;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          name: 'missing',
        },
        makePlanningState(),
        makeCtx(),
      );
      expect(result.result).toContain('No workflow named "missing"');
      expect(result.result).toContain('(none)');
    });
  });

  describe('exitPlanMode', () => {
    it('transitions to executing when PRD and tree exist', async () => {
      const layer = planContext();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          prd: '# PRD',
          planTree: makeDoc(),
        }),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Executing);
    });

    it('rejects execute without PRD', async () => {
      const layer = planContext();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          planTree: makeDoc(),
        }),
        makeCtx(),
      );
      expect(result.result).toContain('no PRD');
    });

    it('rejects execute without plan tree', async () => {
      const layer = planContext();
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

    it('rejects execute when the tree has a dangling subflow ref', async () => {
      const layer = planContext();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          prd: '# PRD',
          planTree: makeDoc(makeSubflow('undefined-flow')),
        }),
        makeCtx(),
      );
      expect(result.result).toContain('no matching workflow');
      expect(result.result).toContain('"undefined-flow"');
      expect(result.result).toContain('the plan tree');
    });

    it('rejects execute when a stored workflow has a dangling ref', async () => {
      const layer = planContext();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          prd: '# PRD',
          planTree: makeDoc(makeSubflow('verify')),
          workflows: {
            verify: makeDoc(makeSubflow('lint')),
          },
        }),
        makeCtx(),
      );
      expect(result.result).toContain('no matching workflow');
      expect(result.result).toContain('"lint"');
      expect(result.result).toContain('workflow "verify"');
    });

    it('rejects execute when named workflows form a cycle', async () => {
      const layer = planContext();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          prd: '# PRD',
          planTree: makeDoc(makeSubflow('a')),
          workflows: {
            a: makeDoc(makeSubflow('b')),
            b: makeDoc(makeSubflow('a', 'back')),
          },
        }),
        makeCtx(),
      );
      expect(result.result).toContain('cycle');
    });

    it('rejects execute when a workflow references itself', async () => {
      const layer = planContext();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          prd: '# PRD',
          planTree: makeDoc(makeSubflow('a')),
          workflows: {
            a: makeDoc(makeSubflow('a', 'again')),
          },
        }),
        makeCtx(),
      );
      expect(result.result).toContain('cycle');
    });

    it('executes when every ref resolves', async () => {
      const layer = planContext();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          prd: '# PRD',
          planTree: makeDoc(makeSubflow('verify')),
          workflows: {
            verify: makeDoc(),
          },
        }),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Executing);
    });

    it('cancels and resets to idle', async () => {
      const layer = planContext();
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'cancel',
        },
        makePlanningState({
          prd: '# Discard me',
          workflows: {
            a: makeDoc(),
          },
        }),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Idle);
      expect(state.prd).toBeNull();
      expect(state.planTree).toBeNull();
      expect(state.workflows).toEqual({});
    });

    it('rejects if not in planning phase', async () => {
      const layer = planContext();
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
      const layer = planContext();
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
      const layer = planContext();
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
      const layer = planContext();
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
      const layer = planContext();
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
      const layer = planContext();
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
      const layer = planContext();
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
      const layer = planContext({
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
      const layer = planContext();
      const fn = layer.provides!.enterPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute({}, makeIdleState(), makeCtx());
      const state = planState(result.state);
      expect(state.planSlug ?? null).toBeNull();
    });

    it('rejected onExit keeps phase in Planning and reports rejection', async () => {
      const layer = planContext({
        onExit: async () => ({
          approved: false,
        }),
      });
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const inputState = makePlanningState({
        prd: '# PRD',
        planTree: makeDoc(),
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
      const layer = planContext({
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
          planTree: makeDoc(),
        }),
        makeCtx(),
      );
      const state = planState(result.state);
      expect(state.phase).toBe(PlanPhase.Executing);
    });

    it('does not call onExit when structural validation fails', async () => {
      let called = 0;
      const layer = planContext({
        onExit: async () => {
          called += 1;
          return {
            approved: true,
          };
        },
      });
      const fn = layer.provides!.exitPlanMode;
      assert(fn.kind === 'function');
      const result = await fn.execute(
        {
          action: 'execute',
        },
        makePlanningState({
          prd: '# PRD',
          planTree: makeDoc(makeSubflow('undefined-flow')),
        }),
        makeCtx(),
      );
      expect(result.result).toContain('no matching workflow');
      expect(called).toBe(0);
    });

    it('appends additionalPlanInstructions to recall payload', async () => {
      const layer = planContext({
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
    it('projects phase, flags, and workflow names from state', () => {
      const layer = planContext();
      const status = layer.provides!.status;
      assert(status.kind === 'data');
      const value = frameworkCast<PlanStatusView>(
        status.read(
          makePlanningState({
            prd: '# PRD',
            planTree: makeDoc(),
            workflows: {
              b: makeDoc(),
              a: makeDoc(),
            },
          }),
        ),
      );
      expect(value.phase).toBe(PlanPhase.Planning);
      expect(value.hasPrd).toBe(true);
      expect(value.hasPlanTree).toBe(true);
      expect(value.workflowNames).toEqual([
        'a',
        'b',
      ]);
      expect(value.version).toBe(1);
    });

    it('reports false when PRD and tree are null', () => {
      const layer = planContext();
      const status = layer.provides!.status;
      assert(status.kind === 'data');
      const value = frameworkCast<PlanStatusView>(status.read(makePlanningState()));
      expect(value.hasPrd).toBe(false);
      expect(value.hasPlanTree).toBe(false);
      expect(value.workflowNames).toEqual([]);
    });
  });

  //#endregion
});
