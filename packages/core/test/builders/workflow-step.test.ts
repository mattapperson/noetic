import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { Context, WorkflowDocument, WorkflowNode } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import { step, stepWorkflow } from '../../src/builders/workflow-step';
import { makeMockContext, makeMockHarness, makeTestTool } from '../_helpers';

const INLINE_DOC: WorkflowDocument = {
  version: 1,
  root: {
    kind: 'llm',
    id: 'inner',
    instructions: 'do it',
  },
};

/**
 * A context whose harness.run records every (step, input) pair and actually
 * executes `run` steps, so hydrated wrappers (subflow, sequence) resolve.
 */
function makeRecordingContext(): {
  ctx: Context;
  executed: Array<{
    kind: string;
    id: string;
    input: string;
  }>;
} {
  const executed: Array<{
    kind: string;
    id: string;
    input: string;
  }> = [];
  const harness = makeMockHarness();
  harness.run = frameworkCast(async (target: unknown, input: unknown, execCtx: Context) => {
    const s = frameworkCast<
      WorkflowNode & {
        execute?: (i: string, c: Context) => Promise<string>;
      }
    >(target);
    executed.push({
      kind: s.kind,
      id: s.id ?? '',
      input: String(input),
    });
    if (s.kind === 'run' && s.execute) {
      return s.execute(String(input), execCtx);
    }
    return String(input);
  });
  return {
    ctx: makeMockContext({
      harness,
    }),
    executed,
  };
}

describe('step.workflow — build-time validation', () => {
  test('empty id throws EMPTY_STEP_ID', () => {
    try {
      stepWorkflow({
        id: '  ',
        document: INLINE_DOC,
      });
      expect.unreachable('expected EMPTY_STEP_ID');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('EMPTY_STEP_ID');
    }
  });

  test('both document and ref throws INVALID_WORKFLOW_SOURCE', () => {
    try {
      stepWorkflow({
        id: 'both',
        document: INLINE_DOC,
        ref: 'named',
      });
      expect.unreachable('expected INVALID_WORKFLOW_SOURCE');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('INVALID_WORKFLOW_SOURCE');
    }
  });

  test('neither document nor ref throws INVALID_WORKFLOW_SOURCE', () => {
    try {
      stepWorkflow({
        id: 'neither',
      });
      expect.unreachable('expected INVALID_WORKFLOW_SOURCE');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('INVALID_WORKFLOW_SOURCE');
    }
  });

  test('the composed step namespace exposes the base builders plus workflow', () => {
    expect(typeof step.run).toBe('function');
    expect(typeof step.llm).toBe('function');
    expect(typeof step.workflow).toBe('function');
    expect(step.workflow).toBe(stepWorkflow);
  });
});

describe('step.workflow — execution', () => {
  test('missing harness throws MISSING_HARNESS_CONTEXT', async () => {
    const built = stepWorkflow({
      id: 'wf-no-harness',
      document: INLINE_DOC,
    });
    const ctx = frameworkCast<Context>({
      ...makeMockContext(),
      harness: undefined,
    });
    try {
      await built.execute('in', ctx);
      expect.unreachable('expected MISSING_HARNESS_CONTEXT');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_HARNESS_CONTEXT');
    }
  });

  test('inline document hydrates and executes via the harness', async () => {
    const built = stepWorkflow({
      id: 'wf-inline',
      document: INLINE_DOC,
    });
    const { ctx, executed } = makeRecordingContext();
    const result = await built.execute('hello', ctx);
    expect(result).toBe('hello');
    expect(executed[0]?.kind).toBe('llm');
    expect(executed[0]?.id).toBe('inner');
  });

  test('ref resolves from the workflows registry', async () => {
    const built = stepWorkflow({
      id: 'wf-ref',
      ref: 'named',
      workflows: new Map([
        [
          'named',
          INLINE_DOC,
        ],
      ]),
    });
    const { ctx, executed } = makeRecordingContext();
    await built.execute('in', ctx);
    expect(executed[0]?.kind).toBe('llm');
  });

  test('unknown ref throws UNKNOWN_WORKFLOW_REFERENCE at execution time', async () => {
    const built = stepWorkflow({
      id: 'wf-missing',
      ref: 'missing',
      workflows: new Map(),
    });
    const { ctx } = makeRecordingContext();
    try {
      await built.execute('in', ctx);
      expect.unreachable('expected UNKNOWN_WORKFLOW_REFERENCE');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_WORKFLOW_REFERENCE');
      expect(e.hint).toContain('(none)');
    }
  });

  test('a self-referencing named workflow throws WORKFLOW_CYCLE via the seeded ancestry', async () => {
    const selfRef: WorkflowDocument = {
      version: 1,
      root: {
        kind: 'subflow',
        id: 'again',
        ref: 'a',
      },
    };
    const built = stepWorkflow({
      id: 'wf-cycle',
      ref: 'a',
      workflows: new Map([
        [
          'a',
          selfRef,
        ],
      ]),
    });
    const { ctx } = makeRecordingContext();
    try {
      await built.execute('in', ctx);
      expect.unreachable('expected WORKFLOW_CYCLE');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('WORKFLOW_CYCLE');
    }
  });

  test("isolation: 'spawn' wraps the hydrated tree in a spawn step", async () => {
    const built = stepWorkflow({
      id: 'wf-iso',
      document: INLINE_DOC,
      isolation: 'spawn',
    });
    const { ctx, executed } = makeRecordingContext();
    await built.execute('in', ctx);
    expect(executed[0]?.kind).toBe('spawn');
    expect(executed[0]?.id).toBe('wf-iso-spawn');
  });

  test('tool nodes resolve from the tools option; without it hydration fails', async () => {
    const tool = makeTestTool();
    const doc: WorkflowDocument = {
      version: 1,
      root: {
        kind: 'tool',
        id: 'use-tool',
        toolName: tool.name,
      },
    };
    const withTools = stepWorkflow({
      id: 'wf-tools',
      document: doc,
      tools: [
        tool,
      ],
    });
    const { ctx, executed } = makeRecordingContext();
    await withTools.execute('in', ctx);
    expect(executed[0]?.id).toBe('use-tool');

    const withoutTools = stepWorkflow({
      id: 'wf-no-tools',
      document: doc,
    });
    const { ctx: ctx2 } = makeRecordingContext();
    try {
      await withoutTools.execute('in', ctx2);
      expect.unreachable('expected UNKNOWN_TOOL_REFERENCE');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_TOOL_REFERENCE');
    }
  });

  test('a different harness re-hydrates so nested steps run through it', async () => {
    const doc: WorkflowDocument = {
      version: 1,
      root: {
        kind: 'sequence',
        id: 'seq',
        steps: [
          {
            kind: 'llm',
            id: 'leaf',
            instructions: 'do it',
          },
        ],
      },
    };
    const built = stepWorkflow({
      id: 'wf-two-harnesses',
      document: doc,
    });
    const a = makeRecordingContext();
    const b = makeRecordingContext();
    await built.execute('one', a.ctx);
    await built.execute('two', b.ctx);
    // The sequence wrapper drives its children via the executeStep captured at
    // hydration; harness B must see its own leaf execution, not harness A.
    expect(a.executed.map((e) => e.id)).toEqual([
      'seq',
      'leaf',
    ]);
    expect(b.executed.map((e) => e.id)).toEqual([
      'seq',
      'leaf',
    ]);
  });

  test('repeated executions reuse the memoized hydrated tree', async () => {
    const built = stepWorkflow({
      id: 'wf-memo',
      document: INLINE_DOC,
    });
    const { ctx, executed } = makeRecordingContext();
    await built.execute('one', ctx);
    await built.execute('two', ctx);
    expect(executed.map((e) => e.input)).toEqual([
      'one',
      'two',
    ]);
    expect(executed).toHaveLength(2);
  });
});
