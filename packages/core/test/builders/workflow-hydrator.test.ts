import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer } from '@noetic-tools/context';
import type {
  AcpAgent,
  OutputCodec,
  ProcessSubprocessRequest,
  SubprocessAdapter,
  SubprocessHandle,
  Tool,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, isServerToolSpec } from '@noetic-tools/types';
import type { HydrationContext } from '../../src/builders/workflow-hydrator';
import { hydrateNode, hydrateWorkflow } from '../../src/builders/workflow-hydrator';
import type { WorkflowDocument, WorkflowNode } from '../../src/schemas/workflow';
import { makeMockContext, makeTestTool } from '../_helpers';

/**
 * Mock subprocess adapter for `run` node tests. Records every process request
 * and completes each handle with stdout captured into `metadata.result` (or
 * `metadata.error` when `fail` is set), mirroring the contract
 * `runCodeViaSubprocess` relies on — without spawning a real process.
 */
function makeMockSubprocess(opts?: { fail?: boolean }): {
  adapter: SubprocessAdapter;
  calls: ProcessSubprocessRequest[];
} {
  const calls: ProcessSubprocessRequest[] = [];
  const handles = new Map<string, SubprocessHandle>();
  const adapter = frameworkCast<SubprocessAdapter>({
    async spawn(request: ProcessSubprocessRequest): Promise<SubprocessHandle> {
      calls.push(request);
      const id = `mock-${calls.length}`;
      const code = String(request.metadata?.code ?? '');
      const stdin = request.stdin ?? '';
      handles.set(id, {
        id,
        status: opts?.fail ? 'failed' : 'completed',
        startedAt: 'now',
        metadata: opts?.fail
          ? {
              error: {
                message: 'subprocess exited non-zero',
              },
            }
          : {
              result: `OUT:${code}|${stdin}`,
            },
      });
      return {
        id,
        status: 'running',
        startedAt: 'now',
      };
    },
    async get(id: string): Promise<SubprocessHandle | null> {
      return handles.get(id) ?? null;
    },
  });
  return {
    adapter,
    calls,
  };
}

function makeHydrationContext(
  tools: Tool[] = [],
  extra?: Partial<HydrationContext>,
): HydrationContext {
  const toolMap = new Map(
    tools.map((t) => [
      t.name,
      t,
    ]),
  );
  return {
    tools: toolMap,
    executeStep: async (_step, input) => frameworkCast(input),
    ...extra,
  };
}

describe('hydrateNode — llm', () => {
  test('produces StepCallModel with correct fields', () => {
    const node: WorkflowNode = {
      kind: 'callModel',
      id: 'test-llm',
      model: 'openai/gpt-4o-mini',
      instructions: 'Say hello',
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('callModel');
    expect(result.id).toBe('test-llm');
  });

  test('resolves tool names from registry', () => {
    const testTool = makeTestTool();
    const node: WorkflowNode = {
      kind: 'callModel',
      id: 'llm-tools',
      instructions: 'Use tools',
      tools: [
        {
          type: 'test-tool',
        },
      ],
    };
    const ctx = makeHydrationContext([
      testTool,
    ]);
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('callModel');
    assert(result.kind === 'callModel');
    const resolvedTools = typeof result.tools === 'function' ? undefined : result.tools;
    expect(resolvedTools).toHaveLength(1);
  });

  test('throws UNKNOWN_TOOL_REFERENCE for missing tool', () => {
    const node: WorkflowNode = {
      kind: 'callModel',
      id: 'llm-bad-tool',
      instructions: 'Use tools',
      tools: [
        {
          type: 'nonexistent',
        },
      ],
    };
    const ctx = makeHydrationContext();
    expect(() => hydrateNode(node, ctx)).toThrow('nonexistent');
  });

  test('resolves an output codec ref from the uiLibraries registry', () => {
    const codec: OutputCodec<string> = {
      kind: 'codec',
      start: () => ({
        push: () => {},
        finish: (text: string) => text,
      }),
    };
    const node: WorkflowNode = {
      kind: 'callModel',
      id: 'llm-ui',
      instructions: 'Render a dashboard',
      output: {
        codec: 'openui',
        library: 'dashboard-lib',
      },
    };
    const ctx: HydrationContext = {
      ...makeHydrationContext(),
      uiLibraries: new Map([
        [
          'dashboard-lib',
          codec,
        ],
      ]),
    };
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'callModel');
    expect(result.output).toBe(codec);
  });

  test('throws UNKNOWN_UI_LIBRARY_REFERENCE for an unregistered library', () => {
    const node: WorkflowNode = {
      kind: 'callModel',
      id: 'llm-bad-ui',
      instructions: 'Render',
      output: {
        codec: 'openui',
        library: 'missing-lib',
      },
    };
    const ctx = makeHydrationContext();
    try {
      hydrateNode(node, ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_UI_LIBRARY_REFERENCE');
      expect(e.message).toContain('missing-lib');
    }
  });

  test('llm node without an output ref leaves output undefined', () => {
    const node: WorkflowNode = {
      kind: 'callModel',
      id: 'llm-plain',
      instructions: 'Say hello',
    };
    const result = hydrateNode(node, makeHydrationContext());
    assert(result.kind === 'callModel');
    expect(result.output).toBeUndefined();
  });
});

describe('hydrateNode — tool', () => {
  test('produces a step that executes the tool', async () => {
    const testTool = makeTestTool();
    const node: WorkflowNode = {
      kind: 'invokeTool',
      id: 'tool-step',
      toolName: 'test-tool',
      args: {
        query: 'hello',
      },
    };
    const ctx = makeHydrationContext([
      testTool,
    ]);
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('runCode');
    expect(result.id).toBe('tool-step');
  });

  test('throws UNKNOWN_TOOL_REFERENCE for missing tool', () => {
    const node: WorkflowNode = {
      kind: 'invokeTool',
      id: 'tool-bad',
      toolName: 'missing',
    };
    const ctx = makeHydrationContext();
    expect(() => hydrateNode(node, ctx)).toThrow('missing');
  });
});

describe('hydrateNode — conditional', () => {
  test('produces StepConditional', () => {
    const node: WorkflowNode = {
      kind: 'conditional',
      id: 'conditional-test',
      routes: [
        {
          match: 'yes',
          target: {
            kind: 'callModel',
            id: 'yes-step',
            instructions: 'affirm',
          },
        },
      ],
      default: {
        kind: 'callModel',
        id: 'default-step',
        instructions: 'nope',
      },
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('conditional');
    expect(result.id).toBe('conditional-test');
  });

  test('route function matches substring', async () => {
    const node: WorkflowNode = {
      kind: 'conditional',
      id: 'conditional-match',
      routes: [
        {
          match: 'approve',
          target: {
            kind: 'callModel',
            id: 'approved',
            instructions: 'approved',
          },
        },
      ],
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'conditional');
    const selected = await result.route('I approve this', makeMockContext());
    expect(selected).not.toBeNull();
    expect(selected?.id).toBe('approved');
  });

  test('route function returns default for no match', async () => {
    const node: WorkflowNode = {
      kind: 'conditional',
      id: 'conditional-default',
      routes: [
        {
          match: 'xyz',
          target: {
            kind: 'callModel',
            id: 'xyz-step',
            instructions: 'xyz',
          },
        },
      ],
      default: {
        kind: 'callModel',
        id: 'fallback',
        instructions: 'fallback',
      },
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'conditional');
    const selected = await result.route('no match here', makeMockContext());
    expect(selected?.id).toBe('fallback');
  });
});

describe('hydrateNode — inParallel', () => {
  test('produces StepInParallel race', () => {
    const node: WorkflowNode = {
      kind: 'inParallel',
      id: 'inParallel-race',
      mode: 'race',
      paths: [
        {
          kind: 'callModel',
          id: 'p1',
          instructions: 'a',
        },
        {
          kind: 'callModel',
          id: 'p2',
          instructions: 'b',
        },
      ],
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('inParallel');
    assert(result.kind === 'inParallel');
    expect(result.mode).toBe('race');
  });

  test('produces StepInParallel all with merge', () => {
    const node: WorkflowNode = {
      kind: 'inParallel',
      id: 'inParallel-all',
      mode: 'all',
      paths: [
        {
          kind: 'callModel',
          id: 'p1',
          instructions: 'a',
        },
      ],
      merge: 'concat',
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('inParallel');
    assert(result.kind === 'inParallel');
    assert(result.mode === 'all');
    const merged = result.merge(
      [
        'hello',
        'world',
      ],
      makeMockContext(),
    );
    expect(merged).toBe('hello\nworld');
  });
});

describe('hydrateNode — spawn', () => {
  test('produces StepSpawn', () => {
    const node: WorkflowNode = {
      kind: 'spawn',
      id: 'spawn-test',
      child: {
        kind: 'callModel',
        id: 'child',
        instructions: 'run',
      },
      timeout: 1e4,
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('spawn');
    assert(result.kind === 'spawn');
    expect(result.timeout).toBe(1e4);
    expect(result.child.kind).toBe('callModel');
  });

  test('leaves memory undefined when no layers are named (child inherits parent layers)', () => {
    const node: WorkflowNode = {
      kind: 'spawn',
      id: 'spawn-inherit',
      child: {
        kind: 'callModel',
        id: 'child',
        instructions: 'run',
      },
    };
    const result = hydrateNode(node, makeHydrationContext());
    assert(result.kind === 'spawn');
    expect(result.context).toBeUndefined();
  });

  test('resolves named layers onto the spawned child', () => {
    const mockLayer: ContextLayer = frameworkCast({
      id: 'task-state',
      slot: 110,
    });
    const node: WorkflowNode = {
      kind: 'spawn',
      id: 'spawn-with-layers',
      child: {
        kind: 'callModel',
        id: 'child',
        instructions: 'run',
      },
      layers: [
        'task-state',
      ],
    };
    const ctx = makeHydrationContext();
    ctx.layers = new Map([
      [
        'task-state',
        mockLayer,
      ],
    ]);
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'spawn');
    expect(result.context).toEqual([
      mockLayer,
    ]);
  });

  test('throws UNKNOWN_LAYER_REFERENCE for a missing spawn layer', () => {
    const node: WorkflowNode = {
      kind: 'spawn',
      id: 'spawn-bad-layer',
      child: {
        kind: 'callModel',
        id: 'child',
        instructions: 'run',
      },
      layers: [
        'nonexistent',
      ],
    };
    const ctx = makeHydrationContext();
    ctx.layers = new Map();
    try {
      hydrateNode(node, ctx);
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_LAYER_REFERENCE');
      expect(e.message).toContain("spawn node 'spawn-bad-layer'");
    }
  });
});

describe('hydrateNode — loop', () => {
  test('produces StepLoop with until predicate', () => {
    const node: WorkflowNode = {
      kind: 'loop',
      id: 'loop-test',
      body: {
        kind: 'callModel',
        id: 'body',
        instructions: 'iterate',
      },
      until: {
        kind: 'maxSteps',
        n: 3,
      },
      maxIterations: 5,
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('loop');
    assert(result.kind === 'loop');
    expect(result.maxIterations).toBe(5);
    expect(result.steps).toHaveLength(1);
  });

  test('until predicate resolves correctly', async () => {
    const node: WorkflowNode = {
      kind: 'loop',
      id: 'loop-pred',
      body: {
        kind: 'callModel',
        id: 'body',
        instructions: 'iterate',
      },
      until: {
        kind: 'outputContains',
        marker: 'DONE',
      },
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'loop');
    const verdict = await result.until({
      stepCount: 1,
      tokens: {
        input: 0,
        output: 0,
        total: 0,
      },
      elapsed: 0,
      cost: 0,
      lastOutput: 'DONE',
      lastText: 'DONE',
      history: [],
      depth: 0,
    });
    expect(verdict.stop).toBe(true);
  });

  test('until predicate boundary: N-1 does not stop', async () => {
    const node: WorkflowNode = {
      kind: 'loop',
      id: 'loop-boundary',
      body: {
        kind: 'callModel',
        id: 'body',
        instructions: 'iterate',
      },
      until: {
        kind: 'maxSteps',
        n: 3,
      },
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'loop');
    const verdict = await result.until({
      stepCount: 2,
      tokens: {
        input: 0,
        output: 0,
        total: 0,
      },
      elapsed: 0,
      cost: 0,
      lastOutput: '',
      lastText: '',
      history: [],
      depth: 0,
    });
    expect(verdict.stop).toBe(false);
  });

  test('until predicate boundary: N stops', async () => {
    const node: WorkflowNode = {
      kind: 'loop',
      id: 'loop-boundary-n',
      body: {
        kind: 'callModel',
        id: 'body',
        instructions: 'iterate',
      },
      until: {
        kind: 'maxSteps',
        n: 3,
      },
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'loop');
    const verdict = await result.until({
      stepCount: 3,
      tokens: {
        input: 0,
        output: 0,
        total: 0,
      },
      elapsed: 0,
      cost: 0,
      lastOutput: '',
      lastText: '',
      history: [],
      depth: 0,
    });
    expect(verdict.stop).toBe(true);
  });
});

describe('hydrateNode — sequence', () => {
  test('produces StepRunCode that chains children', () => {
    const node: WorkflowNode = {
      kind: 'sequence',
      id: 'seq-test',
      steps: [
        {
          kind: 'callModel',
          id: 'step-1',
          instructions: 'first',
        },
        {
          kind: 'callModel',
          id: 'step-2',
          instructions: 'second',
        },
      ],
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('runCode');
    expect(result.id).toBe('seq-test');
  });
});

describe('hydrateNode — subflow', () => {
  /**
   * An executeStep that records every (step, input) pair and actually runs
   * `run` steps, so nested subflow wrappers resolve — the echo default would
   * never execute the inner wrapper, hiding transitive cycles.
   */
  function makeExecutingContext(workflows?: ReadonlyMap<string, WorkflowDocument>): {
    ctx: HydrationContext;
    executed: Array<{
      id: string;
      input: string;
      step: unknown;
    }>;
  } {
    const executed: Array<{
      id: string;
      input: string;
      step: unknown;
    }> = [];
    const ctx: HydrationContext = {
      tools: new Map(),
      workflows,
      executeStep: async (step, input, execCtx) => {
        executed.push({
          id: step.id ?? '',
          input: String(input),
          step,
        });
        if (step.kind === 'runCode') {
          return frameworkCast(await step.execute(frameworkCast(input), execCtx));
        }
        return frameworkCast(input);
      },
    };
    return {
      ctx,
      executed,
    };
  }

  const innerLlm = (id = 'inner'): WorkflowNode => ({
    kind: 'callModel',
    id,
    instructions: 'do it',
  });

  test('inline document hydrates lazily and executes with suffixed ids', async () => {
    const node: WorkflowNode = {
      kind: 'subflow',
      id: 'sub',
      document: {
        version: 1,
        root: innerLlm(),
      },
    };
    const { ctx, executed } = makeExecutingContext();
    const wrapper = hydrateNode(node, ctx);
    expect(wrapper.kind).toBe('runCode');
    assert(wrapper.kind === 'runCode');
    const result = await wrapper.execute('hello', makeMockContext());
    expect(result).toBe('hello');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.id).toBe('inner-sub');
    expect(executed[0]?.input).toBe('hello');
  });

  test('ref resolves from the workflows registry', async () => {
    const workflows = new Map<string, WorkflowDocument>([
      [
        'named',
        {
          version: 1,
          root: innerLlm(),
        },
      ],
    ]);
    const node: WorkflowNode = {
      kind: 'subflow',
      id: 'sub',
      ref: 'named',
    };
    const { ctx, executed } = makeExecutingContext(workflows);
    const wrapper = hydrateNode(node, ctx);
    assert(wrapper.kind === 'runCode');
    await wrapper.execute('in', makeMockContext());
    expect(executed[0]?.id).toBe('inner-sub');
  });

  test('input field overrides the runtime input', async () => {
    const node: WorkflowNode = {
      kind: 'subflow',
      id: 'sub',
      input: 'literal',
      document: {
        version: 1,
        root: innerLlm(),
      },
    };
    const { ctx, executed } = makeExecutingContext();
    const wrapper = hydrateNode(node, ctx);
    assert(wrapper.kind === 'runCode');
    await wrapper.execute('runtime', makeMockContext());
    expect(executed[0]?.input).toBe('literal');
  });

  test('unknown ref throws UNKNOWN_WORKFLOW_REFERENCE at execution time', async () => {
    const node: WorkflowNode = {
      kind: 'subflow',
      id: 'sub',
      ref: 'missing',
    };
    const { ctx } = makeExecutingContext(new Map());
    const wrapper = hydrateNode(node, ctx);
    assert(wrapper.kind === 'runCode');
    try {
      await wrapper.execute('in', makeMockContext());
      expect.unreachable('expected UNKNOWN_WORKFLOW_REFERENCE');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_WORKFLOW_REFERENCE');
      expect(e.hint).toContain('(none)');
    }
  });

  test('direct self-reference throws WORKFLOW_CYCLE', async () => {
    const workflows = new Map<string, WorkflowDocument>([
      [
        'a',
        {
          version: 1,
          root: {
            kind: 'subflow',
            id: 'again',
            ref: 'a',
          },
        },
      ],
    ]);
    const node: WorkflowNode = {
      kind: 'subflow',
      id: 'root',
      ref: 'a',
    };
    const { ctx } = makeExecutingContext(workflows);
    const wrapper = hydrateNode(node, ctx);
    assert(wrapper.kind === 'runCode');
    try {
      await wrapper.execute('in', makeMockContext());
      expect.unreachable('expected WORKFLOW_CYCLE');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('WORKFLOW_CYCLE');
    }
  });

  test('transitive cycle a -> b -> a throws WORKFLOW_CYCLE', async () => {
    const workflows = new Map<string, WorkflowDocument>([
      [
        'a',
        {
          version: 1,
          root: {
            kind: 'subflow',
            id: 'to-b',
            ref: 'b',
          },
        },
      ],
      [
        'b',
        {
          version: 1,
          root: {
            kind: 'subflow',
            id: 'back-to-a',
            ref: 'a',
          },
        },
      ],
    ]);
    const node: WorkflowNode = {
      kind: 'subflow',
      id: 'root',
      ref: 'a',
    };
    const { ctx } = makeExecutingContext(workflows);
    const wrapper = hydrateNode(node, ctx);
    assert(wrapper.kind === 'runCode');
    try {
      await wrapper.execute('in', makeMockContext());
      expect.unreachable('expected WORKFLOW_CYCLE');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('WORKFLOW_CYCLE');
      expect(e.message).toContain('a -> b -> a');
    }
  });

  test('diamond reuse of the same workflow from sibling nodes is legal', async () => {
    const workflows = new Map<string, WorkflowDocument>([
      [
        'shared',
        {
          version: 1,
          root: innerLlm(),
        },
      ],
    ]);
    const { ctx, executed } = makeExecutingContext(workflows);
    const first = hydrateNode(
      {
        kind: 'subflow',
        id: 'left',
        ref: 'shared',
      },
      ctx,
    );
    const second = hydrateNode(
      {
        kind: 'subflow',
        id: 'right',
        ref: 'shared',
      },
      ctx,
    );
    assert(first.kind === 'runCode');
    assert(second.kind === 'runCode');
    await first.execute('x', makeMockContext());
    await second.execute('y', makeMockContext());
    expect(executed.map((e) => e.id)).toEqual([
      'inner-left',
      'inner-right',
    ]);
  });

  test('a workflow registered after hydration still resolves', async () => {
    const workflows = new Map<string, WorkflowDocument>();
    const { ctx, executed } = makeExecutingContext(workflows);
    const wrapper = hydrateNode(
      {
        kind: 'subflow',
        id: 'sub',
        ref: 'late',
      },
      ctx,
    );
    workflows.set('late', {
      version: 1,
      root: innerLlm(),
    });
    assert(wrapper.kind === 'runCode');
    await wrapper.execute('in', makeMockContext());
    expect(executed[0]?.id).toBe('inner-sub');
  });

  test('repeated executions reuse the memoized hydrated child', async () => {
    const node: WorkflowNode = {
      kind: 'subflow',
      id: 'sub',
      document: {
        version: 1,
        root: innerLlm(),
      },
    };
    const { ctx, executed } = makeExecutingContext();
    const wrapper = hydrateNode(node, ctx);
    assert(wrapper.kind === 'runCode');
    await wrapper.execute('one', makeMockContext());
    await wrapper.execute('two', makeMockContext());
    expect(executed).toHaveLength(2);
    expect(Object.is(executed[0]?.step, executed[1]?.step)).toBe(true);
  });
});

describe('hydrateNode — every', () => {
  test('produces StepSchedule', () => {
    const node: WorkflowNode = {
      kind: 'schedule',
      id: 'every-test',
      step: {
        kind: 'callModel',
        id: 'periodic',
        instructions: 'check',
      },
      interval: 1e3,
      onError: 'fail',
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('schedule');
    assert(result.kind === 'schedule');
    expect(result.interval).toBe(1e3);
    expect(result.onError).toBe('fail');
  });
});

describe('hydrateWorkflow', () => {
  test('hydrates a full document', () => {
    const doc: WorkflowDocument = {
      version: 1,
      root: {
        kind: 'sequence',
        id: 'root',
        steps: [
          {
            kind: 'callModel',
            id: 'first',
            instructions: 'hello',
          },
          {
            kind: 'callModel',
            id: 'second',
            instructions: 'world',
          },
        ],
      },
    };
    const ctx = makeHydrationContext();
    const result = hydrateWorkflow(doc, ctx);
    expect(result.kind).toBe('runCode');
    expect(result.id).toBe('root');
  });
});

describe('hydrateNode — provide', () => {
  test('produces StepWithContext with resolved layers', () => {
    const mockLayer: ContextLayer = frameworkCast({
      id: 'test-layer',
      slot: 0,
    });
    const node: WorkflowNode = {
      kind: 'withContext',
      id: 'provide-test',
      child: {
        kind: 'callModel',
        id: 'inner',
        instructions: 'work',
      },
      layers: [
        'test-layer',
      ],
    };
    const ctx = makeHydrationContext();
    ctx.layers = new Map([
      [
        'test-layer',
        mockLayer,
      ],
    ]);
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('withContext');
    assert(result.kind === 'withContext');
    expect(result.id).toBe('provide-test');
  });

  test('passes through child when no layers registry', () => {
    const node: WorkflowNode = {
      kind: 'withContext',
      id: 'provide-no-layers',
      child: {
        kind: 'callModel',
        id: 'inner',
        instructions: 'work',
      },
      layers: [
        'missing',
      ],
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('withContext');
  });
});

describe('hydrateNode — error cases', () => {
  test('throws UNKNOWN_UNTIL_PREDICATE for invalid predicate kind', () => {
    const node: WorkflowNode = {
      kind: 'loop',
      id: 'loop-bad',
      body: {
        kind: 'callModel',
        id: 'body',
        instructions: 'iterate',
      },
      until: frameworkCast({
        kind: 'invalid',
        n: 5,
      }),
    };
    const ctx = makeHydrationContext();
    try {
      hydrateNode(node, ctx);
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_UNTIL_PREDICATE');
    }
  });

  test('throws UNKNOWN_TOOL_REFERENCE for missing llm tool', () => {
    const node: WorkflowNode = {
      kind: 'callModel',
      id: 'llm-bad-tool',
      instructions: 'test',
      tools: [
        {
          type: 'nonexistent',
        },
      ],
    };
    const ctx = makeHydrationContext();
    try {
      hydrateNode(node, ctx);
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_TOOL_REFERENCE');
    }
  });

  test('throws UNKNOWN_TOOL_REFERENCE for missing tool node', () => {
    const node: WorkflowNode = {
      kind: 'invokeTool',
      id: 'tool-bad',
      toolName: 'missing',
    };
    const ctx = makeHydrationContext();
    try {
      hydrateNode(node, ctx);
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_TOOL_REFERENCE');
    }
  });

  test('throws UNKNOWN_LAYER_REFERENCE for missing provide layer', () => {
    const node: WorkflowNode = {
      kind: 'withContext',
      id: 'provide-bad',
      child: {
        kind: 'callModel',
        id: 'inner',
        instructions: 'work',
      },
      layers: [
        'nonexistent',
      ],
    };
    const ctx = makeHydrationContext();
    ctx.layers = new Map();
    try {
      hydrateNode(node, ctx);
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_LAYER_REFERENCE');
    }
  });
});

describe('hydrateNode — predicate boundary N+1', () => {
  test('until maxSteps N+1 also stops', async () => {
    const node: WorkflowNode = {
      kind: 'loop',
      id: 'loop-np1',
      body: {
        kind: 'callModel',
        id: 'body',
        instructions: 'iterate',
      },
      until: {
        kind: 'maxSteps',
        n: 3,
      },
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'loop');
    const verdict = await result.until({
      stepCount: 4,
      tokens: {
        input: 0,
        output: 0,
        total: 0,
      },
      elapsed: 0,
      cost: 0,
      lastOutput: '',
      lastText: '',
      history: [],
      depth: 0,
    });
    expect(verdict.stop).toBe(true);
  });
});

describe('hydrateNode — acp-agent', () => {
  function fakeAgent(agentId: string): AcpAgent {
    return {
      specificationVersion: 'acp-v1',
      agentId,
      async connect() {
        throw new Error('not connected in hydration tests');
      },
    };
  }

  function ctxWithAgent(agentId: string): HydrationContext {
    return {
      tools: new Map(),
      executeStep: async (_step, input) => frameworkCast(input),
      acpAgents: new Map([
        [
          agentId,
          fakeAgent(agentId),
        ],
      ]),
    };
  }

  test('hydrates an acp-agent node into a StepAcpAgent with the resolved adapter', () => {
    const node: WorkflowNode = {
      kind: 'acp-agent',
      id: 'review',
      agent: 'claude-code',
      prompt: 'review the diff',
      mode: 'plan',
    };
    const result = hydrateNode(node, ctxWithAgent('claude-code'));
    expect(result.kind).toBe('acp-agent');
    expect(result.id).toBe('review');
  });

  test('the agent registry is an open set — any id resolves', () => {
    const agentIds = [
      'claude-code',
      'codex',
      'gemini',
      'some-future-agent',
    ];
    for (const agentId of agentIds) {
      const node: WorkflowNode = {
        kind: 'acp-agent',
        id: `n-${agentId}`,
        agent: agentId,
        prompt: 'go',
      };
      const result = hydrateNode(node, ctxWithAgent(agentId));
      expect(result.kind).toBe('acp-agent');
    }
  });

  test('carries the permission policy through to the step', () => {
    const node: WorkflowNode = {
      kind: 'acp-agent',
      id: 'guarded',
      agent: 'claude-code',
      prompt: 'go',
      permissions: {
        default: 'deny',
        allow: [
          {
            kind: 'read',
          },
        ],
      },
    };
    const result = hydrateNode(node, ctxWithAgent('claude-code'));
    assert(result.kind === 'acp-agent');
    expect(result.permissions?.default).toBe('deny');
    expect(result.permissions?.allow).toHaveLength(1);
  });

  test('throws UNKNOWN_ACP_AGENT_REFERENCE when no adapter is registered', () => {
    const node: WorkflowNode = {
      kind: 'acp-agent',
      id: 'x',
      agent: 'codex',
      prompt: 'go',
    };
    try {
      hydrateNode(node, makeHydrationContext());
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_ACP_AGENT_REFERENCE');
    }
  });
});

describe('hydrateNode — llm server tools (via tools array)', () => {
  test('carries an inline server-tool spec through tools alongside a client tool', () => {
    const testTool = makeTestTool();
    const node: WorkflowNode = {
      kind: 'callModel',
      id: 'search',
      instructions: 'Search the web',
      tools: [
        {
          type: 'test-tool',
        },
        {
          type: 'openrouter:web_search',
          parameters: {
            maxResults: 6,
            searchContextSize: 'medium',
          },
        },
      ],
    };
    const result = hydrateNode(
      node,
      makeHydrationContext([
        testTool,
      ]),
    );
    assert(result.kind === 'callModel');
    const tools = typeof result.tools === 'function' ? [] : (result.tools ?? []);
    // Client tool resolved from the registry + inline server-tool spec, in order.
    expect(tools).toHaveLength(2);
    expect(isServerToolSpec(tools[0])).toBe(false);
    expect(tools[1]).toEqual({
      type: 'openrouter:web_search',
      parameters: {
        maxResults: 6,
        searchContextSize: 'medium',
      },
    });
  });

  test('a tools array of only server specs hydrates with no client tools', () => {
    const node: WorkflowNode = {
      kind: 'callModel',
      id: 'fetch',
      instructions: 'Fetch a URL',
      tools: [
        {
          type: 'openrouter:web_fetch',
        },
      ],
    };
    const result = hydrateNode(node, makeHydrationContext());
    assert(result.kind === 'callModel');
    const tools = typeof result.tools === 'function' ? [] : (result.tools ?? []);
    expect(tools).toHaveLength(1);
    expect(isServerToolSpec(tools[0])).toBe(true);
  });
});

describe('hydrateNode — dynamic inParallel (each / over)', () => {
  test('fan-out width follows the input array length (no over)', () => {
    const node: WorkflowNode = {
      kind: 'inParallel',
      id: 'fan',
      mode: 'all',
      each: {
        kind: 'callModel',
        id: 'worker',
        instructions: 'process item',
      },
      merge: 'concat',
    };
    const result = hydrateNode(node, makeHydrationContext());
    assert(result.kind === 'inParallel');
    assert(result.mode === 'all');
    const ctx = makeMockContext();
    const three = result.paths(
      JSON.stringify([
        'a',
        'b',
        'c',
      ]),
      ctx,
    );
    expect(three).toHaveLength(3);
    const five = result.paths(
      JSON.stringify(
        Array.from(
          {
            length: 5,
          },
          (_v, i) => i,
        ),
      ),
      ctx,
    );
    expect(five).toHaveLength(5);
    // Each instantiated path carries a unique, item-suffixed id.
    const ids = three.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
  });

  test('selects the array via `over` from a JSON object input', () => {
    const node: WorkflowNode = {
      kind: 'inParallel',
      id: 'fan2',
      mode: 'settle',
      over: 'items',
      each: {
        kind: 'callModel',
        id: 'worker',
        instructions: 'process item',
      },
      merge: 'last',
    };
    const result = hydrateNode(node, makeHydrationContext());
    assert(result.kind === 'inParallel');
    const paths = result.paths(
      JSON.stringify({
        items: [
          'x',
          'y',
        ],
      }),
      makeMockContext(),
    );
    expect(paths).toHaveLength(2);
  });

  test('throws INVALID_FORK_INPUT when the input is not an array', () => {
    const node: WorkflowNode = {
      kind: 'inParallel',
      id: 'fan3',
      mode: 'all',
      each: {
        kind: 'callModel',
        id: 'worker',
        instructions: 'process item',
      },
      merge: 'concat',
    };
    const result = hydrateNode(node, makeHydrationContext());
    assert(result.kind === 'inParallel');
    try {
      result.paths(
        JSON.stringify({
          not: 'an array',
        }),
        makeMockContext(),
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('INVALID_FORK_INPUT');
    }
  });

  test('static paths inParallel is unchanged', () => {
    const node: WorkflowNode = {
      kind: 'inParallel',
      id: 'static',
      mode: 'all',
      paths: [
        {
          kind: 'callModel',
          id: 'p1',
          instructions: 'a',
        },
        {
          kind: 'callModel',
          id: 'p2',
          instructions: 'b',
        },
      ],
      merge: 'concat',
    };
    const result = hydrateNode(node, makeHydrationContext());
    assert(result.kind === 'inParallel');
    expect(result.paths(frameworkCast('ignored'), makeMockContext())).toHaveLength(2);
  });
});

describe('hydrateNode — run', () => {
  test('dispatches the code string + input through the subprocess and returns stdout', async () => {
    const { adapter, calls } = makeMockSubprocess();
    const node: WorkflowNode = {
      kind: 'runCode',
      id: 'compute',
      execute: 'process.stdout.write("hi")',
    };
    const result = hydrateNode(node, makeHydrationContext());
    expect(result.kind).toBe('runCode');
    assert(result.kind === 'runCode');
    const ctx = makeMockContext({
      subprocess: adapter,
    });
    const out = await result.execute('the-input', ctx);
    // The mock echoes back the dispatched code + stdin, proving both arrived.
    expect(out).toBe('OUT:process.stdout.write("hi")|the-input');
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('process');
    expect(calls[0].stdin).toBe('the-input');
    expect(calls[0].metadata?.code).toBe('process.stdout.write("hi")');
  });

  test('resolves a named subprocess ref via HydrationContext.resolveSubprocess', async () => {
    const { adapter, calls } = makeMockSubprocess();
    const node: WorkflowNode = {
      kind: 'runCode',
      id: 'compute-ref',
      execute: 'code-body',
      subprocess: 'sandbox',
    };
    const ctx: HydrationContext = {
      ...makeHydrationContext(),
      resolveSubprocess: (ref) => (ref === 'sandbox' ? adapter : undefined),
    };
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'runCode');
    const out = await result.execute('in', makeMockContext());
    expect(out).toBe('OUT:code-body|in');
    expect(calls).toHaveLength(1);
  });

  test('throws UNKNOWN_SUBPROCESS_REFERENCE when the named ref cannot be resolved', async () => {
    const node: WorkflowNode = {
      kind: 'runCode',
      id: 'compute-bad',
      execute: 'code',
      subprocess: 'missing',
    };
    const result = hydrateNode(node, makeHydrationContext());
    assert(result.kind === 'runCode');
    try {
      await result.execute('in', makeMockContext());
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_SUBPROCESS_REFERENCE');
    }
  });

  test('surfaces a non-zero exit / failed handle as a thrown error', async () => {
    const { adapter } = makeMockSubprocess({
      fail: true,
    });
    const node: WorkflowNode = {
      kind: 'runCode',
      id: 'compute-fail',
      execute: 'boom',
    };
    const result = hydrateNode(node, makeHydrationContext());
    assert(result.kind === 'runCode');
    await expect(
      result.execute(
        'in',
        makeMockContext({
          subprocess: adapter,
        }),
      ),
    ).rejects.toThrow('subprocess exited non-zero');
  });
});
