import { describe, expect, test } from 'bun:test';
import type { WorkflowNode } from '../../src/schemas/workflow';
import {
  UntilPredicateSchema,
  validateWorkflow,
  WorkflowDocumentSchema,
  WorkflowNodeSchema,
  walkWorkflow,
  workflowDepth,
} from '../../src/schemas/workflow';

describe('WorkflowDocumentSchema', () => {
  test('validates a minimal llm document', () => {
    const doc = {
      version: 1,
      root: {
        kind: 'callModel',
        id: 'step-1',
        instructions: 'say hello',
      },
    };
    const result = WorkflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(true);
  });

  test('rejects missing version', () => {
    const doc = {
      root: {
        kind: 'callModel',
        id: 'step-1',
        instructions: 'say hello',
      },
    };
    const result = WorkflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  test('rejects wrong version', () => {
    const doc = {
      version: 2,
      root: {
        kind: 'callModel',
        id: 'step-1',
        instructions: 'hello',
      },
    };
    const result = WorkflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  test('rejects empty root id', () => {
    const doc = {
      version: 1,
      root: {
        kind: 'callModel',
        id: '',
        instructions: 'hello',
      },
    };
    const result = WorkflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — llm', () => {
  test('parses llm with all fields', () => {
    const node = {
      kind: 'callModel',
      id: 'llm-1',
      model: 'openai/gpt-4o',
      instructions: 'do stuff',
      tools: [
        {
          type: 'search',
        },
        {
          type: 'openrouter:web_search',
          parameters: {
            maxResults: 5,
          },
        },
      ],
      params: {
        temperature: 0.5,
        maxTokens: 100,
      },
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('parses llm with only required fields', () => {
    const node = {
      kind: 'callModel',
      id: 'llm-2',
      instructions: 'minimal',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects llm without instructions', () => {
    const node = {
      kind: 'callModel',
      id: 'llm-3',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — tool', () => {
  test('parses tool node', () => {
    const node = {
      kind: 'invokeTool',
      id: 'tool-1',
      toolName: 'search',
      args: {
        query: 'test',
      },
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects tool without toolName', () => {
    const node = {
      kind: 'invokeTool',
      id: 'tool-2',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — conditional', () => {
  test('parses conditional with routes and default', () => {
    const node = {
      kind: 'conditional',
      id: 'conditional-1',
      routes: [
        {
          match: 'yes',
          target: {
            kind: 'callModel',
            id: 'yes-path',
            instructions: 'confirmed',
          },
        },
      ],
      default: {
        kind: 'callModel',
        id: 'fallback',
        instructions: 'default path',
      },
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects conditional with empty routes', () => {
    const node = {
      kind: 'conditional',
      id: 'conditional-2',
      routes: [],
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — inParallel', () => {
  test('parses inParallel with race mode', () => {
    const node = {
      kind: 'inParallel',
      id: 'inParallel-1',
      mode: 'race',
      paths: [
        {
          kind: 'callModel',
          id: 'path-a',
          instructions: 'a',
        },
        {
          kind: 'callModel',
          id: 'path-b',
          instructions: 'b',
        },
      ],
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('parses inParallel with all mode and merge', () => {
    const node = {
      kind: 'inParallel',
      id: 'inParallel-2',
      mode: 'all',
      paths: [
        {
          kind: 'callModel',
          id: 'p1',
          instructions: 'a',
        },
      ],
      merge: 'concat',
      concurrency: 3,
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects invalid mode', () => {
    const node = {
      kind: 'inParallel',
      id: 'inParallel-3',
      mode: 'invalid',
      paths: [
        {
          kind: 'callModel',
          id: 'p1',
          instructions: 'a',
        },
      ],
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — spawn', () => {
  test('parses spawn with child and timeout', () => {
    const node = {
      kind: 'spawn',
      id: 'spawn-1',
      child: {
        kind: 'callModel',
        id: 'spawned',
        instructions: 'run',
      },
      timeout: 5e3,
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });
});

describe('WorkflowNodeSchema — provide', () => {
  test('parses provide with layers', () => {
    const node = {
      kind: 'withContext',
      id: 'provide-1',
      child: {
        kind: 'callModel',
        id: 'inner',
        instructions: 'work',
      },
      layers: [
        'working-context',
      ],
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects empty layers', () => {
    const node = {
      kind: 'withContext',
      id: 'provide-2',
      child: {
        kind: 'callModel',
        id: 'inner',
        instructions: 'work',
      },
      layers: [],
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — loop', () => {
  test('parses loop with body and until', () => {
    const node = {
      kind: 'loop',
      id: 'loop-1',
      body: {
        kind: 'callModel',
        id: 'body',
        instructions: 'iterate',
      },
      until: {
        kind: 'maxSteps',
        n: 5,
      },
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('parses loop with maxIterations', () => {
    const node = {
      kind: 'loop',
      id: 'loop-2',
      body: {
        kind: 'callModel',
        id: 'body',
        instructions: 'iterate',
      },
      until: {
        kind: 'noToolCalls',
      },
      maxIterations: 10,
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });
});

describe('WorkflowNodeSchema — sequence', () => {
  test('parses sequence with multiple steps', () => {
    const node = {
      kind: 'sequence',
      id: 'seq-1',
      steps: [
        {
          kind: 'callModel',
          id: 'first',
          instructions: 'step 1',
        },
        {
          kind: 'callModel',
          id: 'second',
          instructions: 'step 2',
        },
      ],
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects empty steps', () => {
    const node = {
      kind: 'sequence',
      id: 'seq-2',
      steps: [],
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — schedule', () => {
  test('parses schedule with step and interval', () => {
    const node = {
      kind: 'schedule',
      id: 'schedule-1',
      step: {
        kind: 'callModel',
        id: 'periodic',
        instructions: 'check',
      },
      interval: 1e3,
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('parses schedule with onError', () => {
    const node = {
      kind: 'schedule',
      id: 'schedule-2',
      step: {
        kind: 'callModel',
        id: 'periodic',
        instructions: 'check',
      },
      interval: 5e2,
      onError: 'fail',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects negative interval', () => {
    const node = {
      kind: 'schedule',
      id: 'schedule-neg',
      step: {
        kind: 'callModel',
        id: 'periodic',
        instructions: 'check',
      },
      interval: -1,
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — subflow', () => {
  test('parses subflow with inline document', () => {
    const node = {
      kind: 'subflow',
      id: 'sub-1',
      document: {
        version: 1,
        root: {
          kind: 'callModel',
          id: 'inner',
          instructions: 'do it',
        },
      },
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('parses subflow with ref and input', () => {
    const node = {
      kind: 'subflow',
      id: 'sub-2',
      ref: 'verify-loop',
      input: 'literal input',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects subflow with both document and ref', () => {
    const node = {
      kind: 'subflow',
      id: 'sub-both',
      ref: 'verify-loop',
      document: {
        version: 1,
        root: {
          kind: 'callModel',
          id: 'inner',
          instructions: 'do it',
        },
      },
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });

  test('rejects subflow with neither document nor ref', () => {
    const node = {
      kind: 'subflow',
      id: 'sub-neither',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });

  test('rejects subflow with empty ref', () => {
    const node = {
      kind: 'subflow',
      id: 'sub-empty',
      ref: '',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });

  test('rejects subflow whose inline document has an invalid root', () => {
    const node = {
      kind: 'subflow',
      id: 'sub-bad-doc',
      document: {
        version: 1,
        root: {
          kind: 'callModel',
          id: 'inner',
        },
      },
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — unknown kind', () => {
  test('rejects unknown node kind', () => {
    const node = {
      kind: 'unknown',
      id: 'bad',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('UntilPredicateSchema', () => {
  test('validates maxSteps', () => {
    const pred = {
      kind: 'maxSteps',
      n: 10,
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(true);
  });

  test('rejects maxSteps with n=0', () => {
    const pred = {
      kind: 'maxSteps',
      n: 0,
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(false);
  });

  test('validates maxCost', () => {
    const pred = {
      kind: 'maxCost',
      usd: 0.5,
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(true);
  });

  test('validates maxDuration', () => {
    const pred = {
      kind: 'maxDuration',
      duration: 3e4,
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(true);
  });

  test('validates noToolCalls', () => {
    const pred = {
      kind: 'noToolCalls',
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(true);
  });

  test('validates outputContains', () => {
    const pred = {
      kind: 'outputContains',
      marker: 'DONE',
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(true);
  });

  test('validates outputEquals', () => {
    const pred = {
      kind: 'outputEquals',
      sentinel: '__STOP__',
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(true);
  });

  test('validates converged with threshold', () => {
    const pred = {
      kind: 'converged',
      threshold: 0.95,
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(true);
  });

  test('validates converged without threshold', () => {
    const pred = {
      kind: 'converged',
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(true);
  });

  test('validates any combinator', () => {
    const pred = {
      kind: 'any',
      predicates: [
        {
          kind: 'maxSteps',
          n: 5,
        },
        {
          kind: 'noToolCalls',
        },
      ],
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(true);
  });

  test('validates nested all-in-any combinator', () => {
    const pred = {
      kind: 'any',
      predicates: [
        {
          kind: 'all',
          predicates: [
            {
              kind: 'maxSteps',
              n: 3,
            },
            {
              kind: 'outputContains',
              marker: 'done',
            },
          ],
        },
      ],
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(true);
  });

  test('rejects unknown predicate kind', () => {
    const pred = {
      kind: 'unknown',
    };
    expect(UntilPredicateSchema.safeParse(pred).success).toBe(false);
  });
});

describe('validateWorkflow', () => {
  test('returns validated document', () => {
    const doc = {
      version: 1,
      root: {
        kind: 'callModel',
        id: 'step-1',
        instructions: 'test',
      },
    };
    const result = validateWorkflow(doc);
    expect(result.version).toBe(1);
    expect(result.root.kind).toBe('callModel');
  });

  test('throws on invalid input', () => {
    expect(() =>
      validateWorkflow({
        version: 2,
      }),
    ).toThrow();
  });
});

describe('walkWorkflow', () => {
  test('walks a nested tree', () => {
    const tree: WorkflowNode = {
      kind: 'sequence',
      id: 'root',
      steps: [
        {
          kind: 'callModel',
          id: 'a',
          instructions: 'a',
        },
        {
          kind: 'inParallel',
          id: 'f',
          mode: 'all',
          paths: [
            {
              kind: 'callModel',
              id: 'b',
              instructions: 'b',
            },
            {
              kind: 'callModel',
              id: 'c',
              instructions: 'c',
            },
          ],
        },
      ],
    };
    const ids = [
      ...walkWorkflow(tree),
    ].map((n) => n.id);
    expect(ids).toEqual([
      'root',
      'a',
      'f',
      'b',
      'c',
    ]);
  });

  test('walks conditional routes and default', () => {
    const tree: WorkflowNode = {
      kind: 'conditional',
      id: 'br',
      routes: [
        {
          match: 'yes',
          target: {
            kind: 'callModel',
            id: 'y',
            instructions: 'yes',
          },
        },
      ],
      default: {
        kind: 'callModel',
        id: 'def',
        instructions: 'default',
      },
    };
    const ids = [
      ...walkWorkflow(tree),
    ].map((n) => n.id);
    expect(ids).toEqual([
      'br',
      'y',
      'def',
    ]);
  });

  test('walks loop body', () => {
    const tree: WorkflowNode = {
      kind: 'loop',
      id: 'lp',
      body: {
        kind: 'callModel',
        id: 'inner',
        instructions: 'iterate',
      },
      until: {
        kind: 'maxSteps',
        n: 5,
      },
    };
    const ids = [
      ...walkWorkflow(tree),
    ].map((n) => n.id);
    expect(ids).toEqual([
      'lp',
      'inner',
    ]);
  });
});

describe('walkWorkflow — subflow', () => {
  test('inline document root is walked as a child', () => {
    const tree: WorkflowNode = {
      kind: 'subflow',
      id: 'sub',
      document: {
        version: 1,
        root: {
          kind: 'callModel',
          id: 'inner',
          instructions: 'deep',
        },
      },
    };
    const ids = [
      ...walkWorkflow(tree),
    ].map((n) => n.id);
    expect(ids).toEqual([
      'sub',
      'inner',
    ]);
  });

  test('a ref subflow is a leaf', () => {
    const tree: WorkflowNode = {
      kind: 'subflow',
      id: 'sub',
      ref: 'named',
    };
    const ids = [
      ...walkWorkflow(tree),
    ].map((n) => n.id);
    expect(ids).toEqual([
      'sub',
    ]);
    expect(workflowDepth(tree)).toBe(0);
  });

  test('inline document adds 1 to depth', () => {
    const tree: WorkflowNode = {
      kind: 'subflow',
      id: 'sub',
      document: {
        version: 1,
        root: {
          kind: 'callModel',
          id: 'inner',
          instructions: 'deep',
        },
      },
    };
    expect(workflowDepth(tree)).toBe(1);
  });
});

describe('workflowDepth', () => {
  test('leaf node has depth 0', () => {
    const node: WorkflowNode = {
      kind: 'callModel',
      id: 'leaf',
      instructions: 'hi',
    };
    expect(workflowDepth(node)).toBe(0);
  });

  test('tool node has depth 0', () => {
    const node: WorkflowNode = {
      kind: 'invokeTool',
      id: 'leaf',
      toolName: 'search',
    };
    expect(workflowDepth(node)).toBe(0);
  });

  test('sequence adds 1', () => {
    const node: WorkflowNode = {
      kind: 'sequence',
      id: 'seq',
      steps: [
        {
          kind: 'callModel',
          id: 'a',
          instructions: 'a',
        },
      ],
    };
    expect(workflowDepth(node)).toBe(1);
  });

  test('nested structure sums depth', () => {
    const node: WorkflowNode = {
      kind: 'inParallel',
      id: 'outer',
      mode: 'all',
      paths: [
        {
          kind: 'spawn',
          id: 'mid',
          child: {
            kind: 'callModel',
            id: 'inner',
            instructions: 'deep',
          },
        },
      ],
    };
    expect(workflowDepth(node)).toBe(2);
  });
});
