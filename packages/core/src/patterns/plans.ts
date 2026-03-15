import { z } from 'zod';
import type { Step } from '../types/step';
import type { Context } from '../types/context';
import { fork } from '../builders/control-flow-builders';

export interface PlanNode {
  id: string;
  description: string;
  assignee: string;
  execution: 'sequential' | 'parallel';
  children?: PlanNode[];
}

// PlanNode schema
export const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    description: z.string(),
    assignee: z.string(),
    execution: z.enum(['sequential', 'parallel']),
    children: z.array(PlanNodeSchema).optional(),
  })
) as z.ZodType<PlanNode>;

export interface PlanConstraints {
  toolAllowlist?: Record<string, string[]>;
  maxStepsPerNode?: number;
  requireApproval?: string[];
  validate?: (taskId: string, input: unknown, ctx: Context) => Promise<boolean>;
}

export function compilePlan<O>(
  plan: PlanNode,
  agents: Record<string, (prompt: string) => Step<string, unknown>>,
  constraints?: PlanConstraints,
): Step<string, O> {
  return compileNode(plan, agents, constraints) as Step<string, O>;
}

function compileNode(
  node: PlanNode,
  agents: Record<string, (prompt: string) => Step<string, unknown>>,
  constraints?: PlanConstraints,
): Step<string, unknown> {
  const agentFactory = agents[node.assignee];
  if (!agentFactory) {
    throw new Error(`Unknown agent: ${node.assignee}`);
  }

  // Leaf node - just create the step
  if (!node.children || node.children.length === 0) {
    return {
      kind: 'run',
      id: `plan-${node.id}`,
      execute: async (input: string, ctx: Context) => {
        const agentStep = agentFactory(node.description);
        // Execute through the interpreter by making it a run step that calls execute
        if (agentStep.kind === 'run') {
          return (agentStep as any).execute(input, ctx);
        }
        throw new Error('Agent must return a run step for compilePlan');
      },
    };
  }

  // Has children - compile them
  const childSteps = node.children.map(child => compileNode(child, agents, constraints));

  if (node.execution === 'parallel') {
    // Use fork(all)
    return fork<string, unknown>({
      id: `plan-fork-${node.id}`,
      mode: 'all',
      paths: () => childSteps,
      merge: (results) => results[results.length - 1], // return last result
    });
  }

  // Sequential - chain steps via a run step
  return {
    kind: 'run',
    id: `plan-seq-${node.id}`,
    execute: async (input: string, ctx: Context) => {
      let currentOutput: unknown = input;
      for (const child of childSteps) {
        if (child.kind === 'run') {
          currentOutput = await (child as any).execute(
            typeof currentOutput === 'string' ? currentOutput : JSON.stringify(currentOutput),
            ctx,
          );
        } else if (child.kind === 'fork') {
          // Need to execute fork - import and use
          const { executeFork } = await import('../interpreter/execute-fork');
          currentOutput = await executeFork(
            child as any,
            typeof currentOutput === 'string' ? currentOutput : JSON.stringify(currentOutput),
            ctx,
            async (s: any, i: any, c: any) => {
              if (s.kind === 'run') return s.execute(i, c);
              throw new Error('Nested non-run steps not supported');
            },
          );
        }
      }
      return currentOutput;
    },
  };
}

export function adaptivePlan<O>(opts: {
  planner: Step<string, PlanNode>;
  agents: Record<string, (prompt: string) => Step<string, unknown>>;
  constraints?: PlanConstraints;
  maxRevisions: number;
}): Step<string, O> {
  return {
    kind: 'run',
    id: 'adaptive-plan',
    execute: async (input: string, ctx: Context) => {
      let lastError: Error | null = null;

      for (let revision = 0; revision < opts.maxRevisions; revision++) {
        // Generate plan
        let plan: PlanNode;
        if (opts.planner.kind === 'run') {
          plan = await (opts.planner as any).execute(
            lastError ? `${input}\n\nPrevious plan failed: ${lastError.message}` : input,
            ctx,
          ) as PlanNode;
        } else {
          throw new Error('Planner must be a run step');
        }

        // Compile and execute
        try {
          const compiled = compilePlan<O>(plan, opts.agents, opts.constraints);
          if (compiled.kind === 'run') {
            return await (compiled as any).execute(input, ctx) as O;
          }
          throw new Error('Compiled plan must be a run step');
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (revision === opts.maxRevisions - 1) throw lastError;
        }
      }

      throw lastError!;
    },
  };
}
