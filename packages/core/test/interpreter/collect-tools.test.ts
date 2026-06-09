import { describe, expect, test } from 'bun:test';
import type { Step, Tool } from '@noetic-tools/types';
import { z } from 'zod';
import { collectAllTools, deduplicateTools } from '../../src/interpreter/collect-tools';
import { makeTestTool } from '../_helpers';

//#region Test Helpers

function makeTool(name: string): Tool {
  return makeTestTool({
    name,
  });
}

function llmStep(id: string, tools?: Tool[]): Step {
  return {
    kind: 'llm',
    id,
    model: 'test/model',
    tools,
  };
}

function runStep(id: string): Step {
  return {
    kind: 'run',
    id,
    execute: async (i: unknown) => i,
  };
}

function toolStep(id: string): Step {
  return {
    kind: 'tool',
    id,
    tool: {
      name: 'direct-tool',
      description: 'direct',
      input: z.object({
        query: z.string(),
      }),
      output: z.object({
        result: z.string(),
      }),
      execute: async () => ({
        result: 'ok',
      }),
    },
  };
}

//#endregion

//#region deduplicateTools

describe('deduplicateTools', () => {
  test('returns empty array for empty input', () => {
    expect(deduplicateTools([])).toEqual([]);
  });

  test('keeps unique tools', () => {
    const a = makeTool('a');
    const b = makeTool('b');
    expect(
      deduplicateTools([
        a,
        b,
      ]),
    ).toEqual([
      a,
      b,
    ]);
  });

  test('deduplicates by name (first-wins)', () => {
    const a1 = makeTool('a');
    const a2 = makeTool('a');
    const b = makeTool('b');
    const result = deduplicateTools([
      a1,
      b,
      a2,
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(a1);
    expect(result[1]).toBe(b);
  });
});

//#endregion

//#region collectAllTools

describe('collectAllTools', () => {
  test('collects tools from a single LLM step', () => {
    const t = makeTool('search');
    const result = collectAllTools(
      llmStep('s1', [
        t,
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('search');
  });

  test('returns empty for LLM step with no tools', () => {
    expect(collectAllTools(llmStep('s1'))).toEqual([]);
  });

  test('returns empty for LLM step with empty tools', () => {
    expect(collectAllTools(llmStep('s1', []))).toEqual([]);
  });

  test('returns empty for run step', () => {
    expect(collectAllTools(runStep('r1'))).toEqual([]);
  });

  test('returns empty for tool step', () => {
    expect(collectAllTools(toolStep('t1'))).toEqual([]);
  });

  test('collects from loop steps', () => {
    const t1 = makeTool('search');
    const t2 = makeTool('calc');
    const loop: Step = {
      kind: 'loop',
      id: 'loop1',
      steps: [
        llmStep('s1', [
          t1,
        ]),
        runStep('r1'),
        llmStep('s2', [
          t2,
        ]),
      ],
      until: () => ({
        stop: true,
      }),
    };
    const result = collectAllTools(loop);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual([
      'search',
      'calc',
    ]);
  });

  test('collects from provide step child', () => {
    const t = makeTool('search');
    const provide: Step = {
      kind: 'provide',
      id: 'p1',
      child: llmStep('s1', [
        t,
      ]),
      memory: [],
    };
    const result = collectAllTools(provide);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('search');
  });

  test('collects from spawn step child', () => {
    const t = makeTool('search');
    const spawn: Step = {
      kind: 'spawn',
      id: 'sp1',
      child: llmStep('s1', [
        t,
      ]),
    };
    const result = collectAllTools(spawn);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('search');
  });

  test('collects from branch _optimizable', () => {
    const t1 = makeTool('search');
    const t2 = makeTool('calc');
    const branch: Step = {
      kind: 'branch',
      id: 'b1',
      route: () => null,
      _optimizable: [
        llmStep('s1', [
          t1,
        ]),
        llmStep('s2', [
          t2,
        ]),
      ],
    };
    const result = collectAllTools(branch);
    expect(result).toHaveLength(2);
  });

  test('returns empty for branch without _optimizable', () => {
    const branch: Step = {
      kind: 'branch',
      id: 'b1',
      route: () => null,
    };
    expect(collectAllTools(branch)).toEqual([]);
  });

  test('collects from fork _optimizable', () => {
    const t = makeTool('search');
    const fork: Step = {
      kind: 'fork',
      id: 'f1',
      mode: 'race',
      paths: () => [],
      _optimizable: [
        llmStep('s1', [
          t,
        ]),
      ],
    };
    const result = collectAllTools(fork);
    expect(result).toHaveLength(1);
  });

  test('deduplicates across nested steps', () => {
    const t1 = makeTool('search');
    const t2 = makeTool('search');
    const t3 = makeTool('calc');
    const loop: Step = {
      kind: 'loop',
      id: 'loop1',
      steps: [
        llmStep('s1', [
          t1,
          t3,
        ]),
        llmStep('s2', [
          t2,
        ]),
      ],
      until: () => ({
        stop: true,
      }),
    };
    const result = collectAllTools(loop);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(t1);
    expect(result[1]).toBe(t3);
  });

  test('deep nesting: loop > provide > branch > llm', () => {
    const t1 = makeTool('search');
    const t2 = makeTool('calc');
    const t3 = makeTool('write');

    const step: Step = {
      kind: 'loop',
      id: 'loop1',
      steps: [
        {
          kind: 'provide',
          id: 'p1',
          child: {
            kind: 'branch',
            id: 'b1',
            route: () => null,
            _optimizable: [
              llmStep('s1', [
                t1,
                t2,
              ]),
              llmStep('s2', [
                t3,
              ]),
            ],
          },
          memory: [],
        },
      ],
      until: () => ({
        stop: true,
      }),
    };
    const result = collectAllTools(step);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual([
      'search',
      'calc',
      'write',
    ]);
  });
});

//#endregion
