import { describe, it, expect } from 'bun:test';
import { compilePlan, adaptivePlan } from '../../src/patterns/plans';
import type { PlanNode } from '../../src/patterns/plans';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { Context } from '../../src/types/context';

describe('compilePlan', () => {
  it('compiles leaf node to executable step', async () => {
    const plan: PlanNode = { id: 'task-1', description: 'Do something', assignee: 'worker', execution: 'sequential' };
    const agents = {
      worker: (prompt: string) => ({
        kind: 'run' as const, id: 'worker-step',
        execute: async (input: string) => `Done: ${prompt}`,
      }),
    };
    const compiled = compilePlan(plan, agents);
    const result = await (compiled as any).execute('input', new ContextImpl());
    expect(result).toBe('Done: Do something');
  });

  it('sequential children pipe output', async () => {
    const plan: PlanNode = {
      id: 'root', description: 'Root', assignee: 'worker', execution: 'sequential',
      children: [
        { id: 'step-1', description: 'Step 1', assignee: 'worker', execution: 'sequential' },
        { id: 'step-2', description: 'Step 2', assignee: 'worker', execution: 'sequential' },
      ],
    };
    const results: string[] = [];
    const agents = {
      worker: (prompt: string) => ({
        kind: 'run' as const, id: `w-${prompt}`,
        execute: async (input: string) => { results.push(prompt); return `${input} -> ${prompt}`; },
      }),
    };
    const compiled = compilePlan(plan, agents);
    await (compiled as any).execute('start', new ContextImpl());
    expect(results).toEqual(['Step 1', 'Step 2']);
  });

  it('throws on unknown agent', () => {
    const plan: PlanNode = { id: 't', description: 'd', assignee: 'unknown', execution: 'sequential' };
    expect(() => compilePlan(plan, {})).toThrow('Unknown agent: unknown');
  });
});

describe('adaptivePlan', () => {
  it('executes plan and returns result', async () => {
    const plan: PlanNode = { id: 'task', description: 'Do it', assignee: 'worker', execution: 'sequential' };
    const planner = {
      kind: 'run' as const, id: 'planner',
      execute: async () => plan,
    };
    const agents = {
      worker: (prompt: string) => ({
        kind: 'run' as const, id: 'w',
        execute: async () => 'success',
      }),
    };
    const step = adaptivePlan({ planner, agents, maxRevisions: 3 });
    const result = await (step as any).execute('goal', new ContextImpl());
    expect(result).toBe('success');
  });

  it('revises on failure up to maxRevisions', async () => {
    let planCount = 0;
    const planner = {
      kind: 'run' as const, id: 'planner',
      execute: async (input: string) => {
        planCount++;
        return { id: 't', description: 'Do it', assignee: 'worker', execution: 'sequential' as const };
      },
    };
    let execCount = 0;
    const agents = {
      worker: () => ({
        kind: 'run' as const, id: 'w',
        execute: async () => {
          execCount++;
          if (execCount < 3) throw new Error('not yet');
          return 'success';
        },
      }),
    };
    const step = adaptivePlan({ planner, agents, maxRevisions: 5 });
    const result = await (step as any).execute('goal', new ContextImpl());
    expect(result).toBe('success');
    expect(planCount).toBe(3);
  });

  it('enforces maxRevisions', async () => {
    const planner = {
      kind: 'run' as const, id: 'planner',
      execute: async () => ({ id: 't', description: 'd', assignee: 'worker', execution: 'sequential' as const }),
    };
    const agents = {
      worker: () => ({
        kind: 'run' as const, id: 'w',
        execute: async () => { throw new Error('always fails'); },
      }),
    };
    const step = adaptivePlan({ planner, agents, maxRevisions: 2 });
    expect((step as any).execute('goal', new ContextImpl())).rejects.toThrow('always fails');
  });
});
