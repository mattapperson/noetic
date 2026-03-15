import { z } from 'zod';
import type { Step, ExecuteStepFn } from '../types/step';
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
  executeStep?: ExecuteStepFn,
): Step<string, O> {
  return compileNode(plan, agents, constraints, executeStep) as Step<string, O>;
}

function compileNode(
  node: PlanNode,
  agents: Record<string, (prompt: string) => Step<string, unknown>>,
  constraints?: PlanConstraints,
  executeStep?: ExecuteStepFn,
): Step<string, unknown> {
  const agentFactory = agents[node.assignee];
  if (!agentFactory) {
    throw new Error(`Unknown agent: ${node.assignee}`);
  }

  // Leaf node - return the step directly from the factory
  if (!node.children || node.children.length === 0) {
    return agentFactory(node.description);
  }

  // Has children - compile them
  const childSteps = node.children.map(child => compileNode(child, agents, constraints, executeStep));

  if (node.execution === 'parallel') {
    return fork<string, unknown>({
      id: `plan-fork-${node.id}`,
      mode: 'all',
      paths: () => childSteps,
      merge: (results) => results[results.length - 1],
    });
  }

  // Sequential - chain steps via a run step that uses executeStep
  return {
    kind: 'run',
    id: `plan-seq-${node.id}`,
    execute: async (input: string, ctx: Context) => {
      let currentOutput: unknown = input;
      for (const child of childSteps) {
        const childInput = typeof currentOutput === 'string' ? currentOutput : JSON.stringify(currentOutput);
        if (executeStep) {
          currentOutput = await executeStep(child, childInput, ctx);
        } else if (child.kind === 'run') {
          currentOutput = await child.execute(childInput, ctx);
        } else {
          throw new Error(`No executeStep provided and child step kind '${child.kind}' cannot be executed directly`);
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
  executeStep?: ExecuteStepFn;
}): Step<string, O> {
  return {
    kind: 'run',
    id: 'adaptive-plan',
    execute: async (input: string, ctx: Context) => {
      let lastError: Error | null = null;

      for (let revision = 0; revision < opts.maxRevisions; revision++) {
        // Generate plan
        let plan: PlanNode;
        if (opts.executeStep) {
          plan = await opts.executeStep(
            opts.planner,
            lastError ? `${input}\n\nPrevious plan failed: ${lastError.message}` : input,
            ctx,
          ) as PlanNode;
        } else if (opts.planner.kind === 'run') {
          plan = await opts.planner.execute(
            lastError ? `${input}\n\nPrevious plan failed: ${lastError.message}` : input,
            ctx,
          ) as PlanNode;
        } else {
          throw new Error('Planner must be a run step when no executeStep provided');
        }

        // Compile and execute
        try {
          const compiled = compilePlan<O>(plan, opts.agents, opts.constraints, opts.executeStep);
          if (opts.executeStep) {
            return await opts.executeStep(compiled, input, ctx) as O;
          } else if (compiled.kind === 'run') {
            return await compiled.execute(input, ctx) as O;
          }
          throw new Error(`No executeStep provided and compiled plan kind '${compiled.kind}' cannot be executed directly`);
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (revision === opts.maxRevisions - 1) throw lastError;
        }
      }

      throw lastError!;
    },
  };
}
