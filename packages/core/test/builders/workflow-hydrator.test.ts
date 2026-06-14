import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { MemoryLayer } from '@noetic-tools/memory';
import type { SubHarness, SubHarnessKind, Tool } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import type { HydrationContext } from '../../src/builders/workflow-hydrator';
import { hydrateNode, hydrateWorkflow } from '../../src/builders/workflow-hydrator';
import type { WorkflowDocument, WorkflowNode } from '../../src/schemas/workflow';
import { makeMockContext, makeTestTool } from '../_helpers';

function makeHydrationContext(tools: Tool[] = []): HydrationContext {
  const toolMap = new Map(
    tools.map((t) => [
      t.name,
      t,
    ]),
  );
  return {
    tools: toolMap,
    executeStep: async (_step, input) => frameworkCast(input),
  };
}

describe('hydrateNode — llm', () => {
  test('produces StepLLM with correct fields', () => {
    const node: WorkflowNode = {
      kind: 'llm',
      id: 'test-llm',
      model: 'openai/gpt-4o-mini',
      instructions: 'Say hello',
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('llm');
    expect(result.id).toBe('test-llm');
  });

  test('resolves tool names from registry', () => {
    const testTool = makeTestTool();
    const node: WorkflowNode = {
      kind: 'llm',
      id: 'llm-tools',
      instructions: 'Use tools',
      tools: [
        'test-tool',
      ],
    };
    const ctx = makeHydrationContext([
      testTool,
    ]);
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('llm');
    assert(result.kind === 'llm');
    const resolvedTools = typeof result.tools === 'function' ? undefined : result.tools;
    expect(resolvedTools).toHaveLength(1);
  });

  test('throws UNKNOWN_TOOL_REFERENCE for missing tool', () => {
    const node: WorkflowNode = {
      kind: 'llm',
      id: 'llm-bad-tool',
      instructions: 'Use tools',
      tools: [
        'nonexistent',
      ],
    };
    const ctx = makeHydrationContext();
    expect(() => hydrateNode(node, ctx)).toThrow('nonexistent');
  });
});

describe('hydrateNode — tool', () => {
  test('produces a step that executes the tool', async () => {
    const testTool = makeTestTool();
    const node: WorkflowNode = {
      kind: 'tool',
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
    expect(result.kind).toBe('run');
    expect(result.id).toBe('tool-step');
  });

  test('throws UNKNOWN_TOOL_REFERENCE for missing tool', () => {
    const node: WorkflowNode = {
      kind: 'tool',
      id: 'tool-bad',
      toolName: 'missing',
    };
    const ctx = makeHydrationContext();
    expect(() => hydrateNode(node, ctx)).toThrow('missing');
  });
});

describe('hydrateNode — branch', () => {
  test('produces StepBranch', () => {
    const node: WorkflowNode = {
      kind: 'branch',
      id: 'branch-test',
      routes: [
        {
          match: 'yes',
          target: {
            kind: 'llm',
            id: 'yes-step',
            instructions: 'affirm',
          },
        },
      ],
      default: {
        kind: 'llm',
        id: 'default-step',
        instructions: 'nope',
      },
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('branch');
    expect(result.id).toBe('branch-test');
  });

  test('route function matches substring', async () => {
    const node: WorkflowNode = {
      kind: 'branch',
      id: 'branch-match',
      routes: [
        {
          match: 'approve',
          target: {
            kind: 'llm',
            id: 'approved',
            instructions: 'approved',
          },
        },
      ],
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'branch');
    const selected = await result.route('I approve this', makeMockContext());
    expect(selected).not.toBeNull();
    expect(selected?.id).toBe('approved');
  });

  test('route function returns default for no match', async () => {
    const node: WorkflowNode = {
      kind: 'branch',
      id: 'branch-default',
      routes: [
        {
          match: 'xyz',
          target: {
            kind: 'llm',
            id: 'xyz-step',
            instructions: 'xyz',
          },
        },
      ],
      default: {
        kind: 'llm',
        id: 'fallback',
        instructions: 'fallback',
      },
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    assert(result.kind === 'branch');
    const selected = await result.route('no match here', makeMockContext());
    expect(selected?.id).toBe('fallback');
  });
});

describe('hydrateNode — fork', () => {
  test('produces StepFork race', () => {
    const node: WorkflowNode = {
      kind: 'fork',
      id: 'fork-race',
      mode: 'race',
      paths: [
        {
          kind: 'llm',
          id: 'p1',
          instructions: 'a',
        },
        {
          kind: 'llm',
          id: 'p2',
          instructions: 'b',
        },
      ],
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('fork');
    assert(result.kind === 'fork');
    expect(result.mode).toBe('race');
  });

  test('produces StepFork all with merge', () => {
    const node: WorkflowNode = {
      kind: 'fork',
      id: 'fork-all',
      mode: 'all',
      paths: [
        {
          kind: 'llm',
          id: 'p1',
          instructions: 'a',
        },
      ],
      merge: 'concat',
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('fork');
    assert(result.kind === 'fork');
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
        kind: 'llm',
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
    expect(result.child.kind).toBe('llm');
  });
});

describe('hydrateNode — loop', () => {
  test('produces StepLoop with until predicate', () => {
    const node: WorkflowNode = {
      kind: 'loop',
      id: 'loop-test',
      body: {
        kind: 'llm',
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
        kind: 'llm',
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
        kind: 'llm',
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
        kind: 'llm',
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
  test('produces StepRun that chains children', () => {
    const node: WorkflowNode = {
      kind: 'sequence',
      id: 'seq-test',
      steps: [
        {
          kind: 'llm',
          id: 'step-1',
          instructions: 'first',
        },
        {
          kind: 'llm',
          id: 'step-2',
          instructions: 'second',
        },
      ],
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('run');
    expect(result.id).toBe('seq-test');
  });
});

describe('hydrateNode — every', () => {
  test('produces StepEvery', () => {
    const node: WorkflowNode = {
      kind: 'every',
      id: 'every-test',
      step: {
        kind: 'llm',
        id: 'periodic',
        instructions: 'check',
      },
      ms: 1e3,
      onError: 'fail',
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('every');
    assert(result.kind === 'every');
    expect(result.ms).toBe(1e3);
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
            kind: 'llm',
            id: 'first',
            instructions: 'hello',
          },
          {
            kind: 'llm',
            id: 'second',
            instructions: 'world',
          },
        ],
      },
    };
    const ctx = makeHydrationContext();
    const result = hydrateWorkflow(doc, ctx);
    expect(result.kind).toBe('run');
    expect(result.id).toBe('root');
  });
});

describe('hydrateNode — provide', () => {
  test('produces StepProvide with resolved layers', () => {
    const mockLayer: MemoryLayer = frameworkCast({
      id: 'test-layer',
      slot: 0,
    });
    const node: WorkflowNode = {
      kind: 'provide',
      id: 'provide-test',
      child: {
        kind: 'llm',
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
    expect(result.kind).toBe('provide');
    assert(result.kind === 'provide');
    expect(result.id).toBe('provide-test');
  });

  test('passes through child when no layers registry', () => {
    const node: WorkflowNode = {
      kind: 'provide',
      id: 'provide-no-layers',
      child: {
        kind: 'llm',
        id: 'inner',
        instructions: 'work',
      },
      layers: [
        'missing',
      ],
    };
    const ctx = makeHydrationContext();
    const result = hydrateNode(node, ctx);
    expect(result.kind).toBe('provide');
  });
});

describe('hydrateNode — error cases', () => {
  test('throws UNKNOWN_UNTIL_PREDICATE for invalid predicate kind', () => {
    const node: WorkflowNode = {
      kind: 'loop',
      id: 'loop-bad',
      body: {
        kind: 'llm',
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
      kind: 'llm',
      id: 'llm-bad-tool',
      instructions: 'test',
      tools: [
        'nonexistent',
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
      kind: 'tool',
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
      kind: 'provide',
      id: 'provide-bad',
      child: {
        kind: 'llm',
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
        kind: 'llm',
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

describe('hydrateNode — harness', () => {
  function fakeHarness(harnessId: SubHarnessKind): SubHarness {
    return {
      specificationVersion: 'harness-v1',
      harnessId,
      async doStart() {
        return {
          sessionId: 's',
          isResume: false,
          async doPromptTurn() {
            return {
              items: [],
              text: '',
            };
          },
          async doStop() {
            return {
              harnessId,
              sessionId: 's',
              state: null,
            };
          },
        };
      },
    };
  }

  function ctxWithHarness(harnessId: SubHarnessKind): HydrationContext {
    return {
      tools: new Map(),
      executeStep: async (_step, input) => frameworkCast(input),
      subHarnesses: new Map([
        [
          harnessId,
          fakeHarness(harnessId),
        ],
      ]),
    };
  }

  test('hydrates a claude-code node into a StepSubHarness with the resolved adapter', () => {
    const node: WorkflowNode = {
      kind: 'claude-code',
      id: 'review',
      prompt: 'review the diff',
      settings: {
        model: 'claude-opus-4-8',
      },
    };
    const result = hydrateNode(node, ctxWithHarness('claude-code'));
    expect(result.kind).toBe('claude-code');
    expect(result.id).toBe('review');
  });

  test('hydrates each harness kind from the registry', () => {
    const kinds: SubHarnessKind[] = [
      'claude-code',
      'codex',
      'opencode',
      'pi',
    ];
    for (const kind of kinds) {
      const node: WorkflowNode = {
        kind,
        id: `n-${kind}`,
        prompt: 'go',
      };
      const result = hydrateNode(node, ctxWithHarness(kind));
      expect(result.kind).toBe(kind);
    }
  });

  test('throws UNKNOWN_HARNESS_REFERENCE when no adapter is registered', () => {
    const node: WorkflowNode = {
      kind: 'codex',
      id: 'x',
      prompt: 'go',
    };
    try {
      hydrateNode(node, makeHydrationContext());
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_SUB_HARNESS_REFERENCE');
    }
  });
});
