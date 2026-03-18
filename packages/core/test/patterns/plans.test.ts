import { describe, expect, it } from 'bun:test';
import { execute } from '../../src/interpreter/execute';
import type { PlanNode } from '../../src/patterns/plans';
import { adaptivePlan, compilePlan } from '../../src/patterns/plans';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { Step } from '../../src/types/step';

describe('compilePlan', () => {
  it('compiles leaf node to executable step', async () => {
    const plan: PlanNode = {
      id: 'task-1',
      description: 'Do something',
      assignee: 'worker',
      execution: 'sequential',
    };
    const agents = {
      worker: (prompt: string) => ({
        kind: 'run' as const,
        id: 'worker-step',
        execute: async (_input: string) => `Done: ${prompt}`,
      }),
    };
    const compiled = compilePlan<string>(plan, agents);
    const result = await execute(compiled, 'input', new ContextImpl());
    expect(result).toBe('Done: Do something');
  });

  it('sequential children pipe output', async () => {
    const plan: PlanNode = {
      id: 'root',
      description: 'Root',
      assignee: 'worker',
      execution: 'sequential',
      children: [
        {
          id: 'step-1',
          description: 'Step 1',
          assignee: 'worker',
          execution: 'sequential',
        },
        {
          id: 'step-2',
          description: 'Step 2',
          assignee: 'worker',
          execution: 'sequential',
        },
      ],
    };
    const receivedInputs: string[] = [];
    const agents = {
      worker: (prompt: string) => ({
        kind: 'run' as const,
        id: `w-${prompt}`,
        execute: async (input: string) => {
          receivedInputs.push(input);
          return `${input} -> ${prompt}`;
        },
      }),
    };
    const compiled = compilePlan<string>(plan, agents);
    await execute(compiled, 'start', new ContextImpl());
    expect(receivedInputs[0]).toBe('start');
    expect(receivedInputs[1]).toBe('start -> Step 1');
  });

  it('throws on unknown agent', () => {
    const plan: PlanNode = {
      id: 't',
      description: 'd',
      assignee: 'unknown',
      execution: 'sequential',
    };
    expect(() => compilePlan(plan, {})).toThrow('Unknown agent: unknown');
  });

  it('parallel execution mode runs all children', async () => {
    const results: string[] = [];
    const plan: PlanNode = {
      id: 'root',
      description: 'Root',
      assignee: 'worker',
      execution: 'parallel',
      children: [
        {
          id: 'p1',
          description: 'Parallel 1',
          assignee: 'worker',
          execution: 'sequential',
        },
        {
          id: 'p2',
          description: 'Parallel 2',
          assignee: 'worker',
          execution: 'sequential',
        },
      ],
    };
    const agents = {
      worker: (prompt: string) => ({
        kind: 'run' as const,
        id: `w-${prompt}`,
        execute: async (_input: string) => {
          results.push(prompt);
          return `done: ${prompt}`;
        },
      }),
    };
    const compiled = compilePlan(plan, agents);
    await execute(compiled, 'start', new ContextImpl());
    expect(results).toContain('Parallel 1');
    expect(results).toContain('Parallel 2');
    expect(results).toHaveLength(2);
  });

  it('deeply nested plan trees', async () => {
    const results: string[] = [];
    const plan: PlanNode = {
      id: 'root',
      description: 'Root',
      assignee: 'worker',
      execution: 'sequential',
      children: [
        {
          id: 'child',
          description: 'Child',
          assignee: 'worker',
          execution: 'sequential',
          children: [
            {
              id: 'grandchild-1',
              description: 'GC1',
              assignee: 'worker',
              execution: 'sequential',
            },
            {
              id: 'grandchild-2',
              description: 'GC2',
              assignee: 'worker',
              execution: 'sequential',
            },
          ],
        },
      ],
    };
    const agents = {
      worker: (prompt: string) => ({
        kind: 'run' as const,
        id: `w-${prompt}`,
        execute: async (input: string) => {
          results.push(prompt);
          return `${input} -> ${prompt}`;
        },
      }),
    };
    const compiled = compilePlan(plan, agents);
    await execute(compiled, 'start', new ContextImpl());
    expect(results).toEqual([
      'GC1',
      'GC2',
    ]);
  });
});

describe('adaptivePlan', () => {
  it('executes plan and returns result', async () => {
    const plan: PlanNode = {
      id: 'task',
      description: 'Do it',
      assignee: 'worker',
      execution: 'sequential',
    };
    const planner = {
      kind: 'run' as const,
      id: 'planner',
      execute: async () => plan,
    };
    const agents = {
      worker: (_prompt: string) => ({
        kind: 'run' as const,
        id: 'w',
        execute: async () => 'success',
      }),
    };
    const step = adaptivePlan<string>({
      planner,
      agents,
      maxRevisions: 3,
    });
    const result = await execute(step, 'goal', new ContextImpl());
    expect(result).toBe('success');
  });

  it('revises on failure up to maxRevisions', async () => {
    let planCount = 0;
    const planner = {
      kind: 'run' as const,
      id: 'planner',
      execute: async (_input: string) => {
        planCount++;
        return {
          id: 't',
          description: 'Do it',
          assignee: 'worker',
          execution: 'sequential' as const,
        };
      },
    };
    let execCount = 0;
    const agents = {
      worker: () => ({
        kind: 'run' as const,
        id: 'w',
        execute: async () => {
          execCount++;
          if (execCount < 3) {
            throw new Error('not yet');
          }
          return 'success';
        },
      }),
    };
    const step = adaptivePlan<string>({
      planner,
      agents,
      maxRevisions: 5,
    });
    const result = await execute(step, 'goal', new ContextImpl());
    expect(result).toBe('success');
    expect(planCount).toBe(3);
    expect(execCount).toBe(3);
  });

  it('enforces maxRevisions', async () => {
    const planner = {
      kind: 'run' as const,
      id: 'planner',
      execute: async () => ({
        id: 't',
        description: 'd',
        assignee: 'worker',
        execution: 'sequential' as const,
      }),
    };
    const agents = {
      worker: () => ({
        kind: 'run' as const,
        id: 'w',
        execute: async () => {
          throw new Error('always fails');
        },
      }),
    };
    const step = adaptivePlan({
      planner,
      agents,
      maxRevisions: 2,
    });
    await expect(execute(step, 'goal', new ContextImpl())).rejects.toThrow('always fails');
  });

  it('planner throws propagates error', async () => {
    const planner = {
      kind: 'run' as const,
      id: 'planner',
      execute: async () => {
        throw new Error('planner exploded');
      },
    };
    const agents = {
      worker: () => ({
        kind: 'run' as const,
        id: 'w',
        execute: async () => 'ok',
      }),
    };
    const step = adaptivePlan({
      planner,
      agents,
      maxRevisions: 3,
    });
    await expect(execute(step, 'goal', new ContextImpl())).rejects.toThrow('planner exploded');
  });

  it('non-run planner without executeStep throws', async () => {
    const planner: Step<string, PlanNode> = {
      kind: 'loop' as const,
      id: 'planner',
      body: {
        kind: 'run' as const,
        id: 'b',
        execute: async () =>
          ({
            id: 'stub',
            description: 'stub',
            assignee: 'none',
            execution: 'sequential' as const,
          }) satisfies PlanNode,
      },
      until: () => ({
        stop: true,
      }),
    };
    const agents = {};
    const step = adaptivePlan({
      planner,
      agents,
      maxRevisions: 1,
    });
    await expect(execute(step, 'goal', new ContextImpl())).rejects.toThrow(
      'Planner must be a run step',
    );
  });
});
