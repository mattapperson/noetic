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
        kind: 'llm',
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
        kind: 'llm',
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
        kind: 'llm',
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
        kind: 'llm',
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
      kind: 'llm',
      id: 'llm-1',
      model: 'openai/gpt-4o',
      instructions: 'do stuff',
      tools: [
        'search',
        'calc',
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
      kind: 'llm',
      id: 'llm-2',
      instructions: 'minimal',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects llm without instructions', () => {
    const node = {
      kind: 'llm',
      id: 'llm-3',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — tool', () => {
  test('parses tool node', () => {
    const node = {
      kind: 'tool',
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
      kind: 'tool',
      id: 'tool-2',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — branch', () => {
  test('parses branch with routes and default', () => {
    const node = {
      kind: 'branch',
      id: 'branch-1',
      routes: [
        {
          match: 'yes',
          target: {
            kind: 'llm',
            id: 'yes-path',
            instructions: 'confirmed',
          },
        },
      ],
      default: {
        kind: 'llm',
        id: 'fallback',
        instructions: 'default path',
      },
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects branch with empty routes', () => {
    const node = {
      kind: 'branch',
      id: 'branch-2',
      routes: [],
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowNodeSchema — fork', () => {
  test('parses fork with race mode', () => {
    const node = {
      kind: 'fork',
      id: 'fork-1',
      mode: 'race',
      paths: [
        {
          kind: 'llm',
          id: 'path-a',
          instructions: 'a',
        },
        {
          kind: 'llm',
          id: 'path-b',
          instructions: 'b',
        },
      ],
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('parses fork with all mode and merge', () => {
    const node = {
      kind: 'fork',
      id: 'fork-2',
      mode: 'all',
      paths: [
        {
          kind: 'llm',
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
      kind: 'fork',
      id: 'fork-3',
      mode: 'invalid',
      paths: [
        {
          kind: 'llm',
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
        kind: 'llm',
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
      kind: 'provide',
      id: 'provide-1',
      child: {
        kind: 'llm',
        id: 'inner',
        instructions: 'work',
      },
      layers: [
        'working-memory',
      ],
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects empty layers', () => {
    const node = {
      kind: 'provide',
      id: 'provide-2',
      child: {
        kind: 'llm',
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
        kind: 'llm',
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
        kind: 'llm',
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
          kind: 'llm',
          id: 'first',
          instructions: 'step 1',
        },
        {
          kind: 'llm',
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

describe('WorkflowNodeSchema — every', () => {
  test('parses every with step and ms', () => {
    const node = {
      kind: 'every',
      id: 'every-1',
      step: {
        kind: 'llm',
        id: 'periodic',
        instructions: 'check',
      },
      ms: 1e3,
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('parses every with onError', () => {
    const node = {
      kind: 'every',
      id: 'every-2',
      step: {
        kind: 'llm',
        id: 'periodic',
        instructions: 'check',
      },
      ms: 5e2,
      onError: 'fail',
    };
    const result = WorkflowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  test('rejects negative ms', () => {
    const node = {
      kind: 'every',
      id: 'every-neg',
      step: {
        kind: 'llm',
        id: 'periodic',
        instructions: 'check',
      },
      ms: -1,
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
      ms: 3e4,
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
        kind: 'llm',
        id: 'step-1',
        instructions: 'test',
      },
    };
    const result = validateWorkflow(doc);
    expect(result.version).toBe(1);
    expect(result.root.kind).toBe('llm');
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
          kind: 'llm',
          id: 'a',
          instructions: 'a',
        },
        {
          kind: 'fork',
          id: 'f',
          mode: 'all',
          paths: [
            {
              kind: 'llm',
              id: 'b',
              instructions: 'b',
            },
            {
              kind: 'llm',
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

  test('walks branch routes and default', () => {
    const tree: WorkflowNode = {
      kind: 'branch',
      id: 'br',
      routes: [
        {
          match: 'yes',
          target: {
            kind: 'llm',
            id: 'y',
            instructions: 'yes',
          },
        },
      ],
      default: {
        kind: 'llm',
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
        kind: 'llm',
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

describe('workflowDepth', () => {
  test('leaf node has depth 0', () => {
    const node: WorkflowNode = {
      kind: 'llm',
      id: 'leaf',
      instructions: 'hi',
    };
    expect(workflowDepth(node)).toBe(0);
  });

  test('tool node has depth 0', () => {
    const node: WorkflowNode = {
      kind: 'tool',
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
          kind: 'llm',
          id: 'a',
          instructions: 'a',
        },
      ],
    };
    expect(workflowDepth(node)).toBe(1);
  });

  test('nested structure sums depth', () => {
    const node: WorkflowNode = {
      kind: 'fork',
      id: 'outer',
      mode: 'all',
      paths: [
        {
          kind: 'spawn',
          id: 'mid',
          child: {
            kind: 'llm',
            id: 'inner',
            instructions: 'deep',
          },
        },
      ],
    };
    expect(workflowDepth(node)).toBe(2);
  });
});
