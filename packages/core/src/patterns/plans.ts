import { z } from 'zod';
import { fork } from '../builders/control-flow-builders';
import { frameworkCast } from '../interpreter/framework-cast';
import type { Context } from '../types/context';
import type { ContextMemory } from '../types/memory';
import type { ExecuteStepFn, Step } from '../types/step';

export interface PlanNode {
  id: string;
  description: string;
  assignee: string;
  execution: 'sequential' | 'parallel';
  children?: PlanNode[];
}

// PlanNode schema — the variable annotation provides the recursive type;
// z.lazy() returns a compatible type that TypeScript checks against it.
/** @public Zod schema for recursive `PlanNode` validation. */
export const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    description: z.string(),
    assignee: z.string(),
    execution: z.enum([
      'sequential',
      'parallel',
    ]),
    children: z.array(PlanNodeSchema).optional(),
  }),
);

export interface PlanConstraints {
  toolAllowlist?: Record<string, string[]>;
  maxStepsPerNode?: number;
  requireApproval?: string[];
  validate?: (taskId: string, input: unknown, ctx: Context) => Promise<boolean>;
}

interface CompileOpts {
  agents: Record<string, (prompt: string) => Step<ContextMemory, string, unknown>>;
  constraints?: PlanConstraints;
  executeStep?: ExecuteStepFn;
}

/**
 * Compiles a `PlanNode` tree into an executable step graph using the provided agent factories.
 *
 * @public
 * @param plan - Root plan node describing the task tree.
 * @param agents - Map of agent names to factory functions producing steps.
 * @param constraints - Optional constraints for tool allowlists and approval.
 * @param executeStep - Optional step executor for non-run step kinds.
 * @returns A compiled `Step` ready for execution.
 */
export function compilePlan<O>(
  plan: PlanNode,
  agents: Record<string, (prompt: string) => Step<ContextMemory, string, unknown>>,
  constraints?: PlanConstraints,
  executeStep?: ExecuteStepFn,
): Step<ContextMemory, string, O> {
  return frameworkCast<Step<ContextMemory, string, O>>(
    compileNode(plan, {
      agents,
      constraints,
      executeStep,
    }),
  );
}

function compileNode(node: PlanNode, opts: CompileOpts): Step<ContextMemory, string, unknown> {
  const agentFactory = opts.agents[node.assignee];
  if (!agentFactory) {
    throw new Error(`Unknown agent: ${node.assignee}`);
  }

  // Leaf node - return the step directly from the factory
  if (!node.children || node.children.length === 0) {
    return agentFactory(node.description);
  }

  // Has children - compile them
  const childSteps = node.children.map((child) => compileNode(child, opts));

  if (node.execution === 'parallel') {
    return fork<ContextMemory, string, unknown>({
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
        const childInput =
          typeof currentOutput === 'string' ? currentOutput : JSON.stringify(currentOutput);
        if (opts.executeStep) {
          currentOutput = await opts.executeStep(child, childInput, ctx);
        } else if (child.kind === 'run') {
          currentOutput = await child.execute(childInput, ctx);
        } else {
          throw new Error(
            `No executeStep provided and child step kind '${child.kind}' cannot be executed directly`,
          );
        }
      }
      return currentOutput;
    },
  };
}

/**
 * Creates a step that dynamically generates a plan via a planner step and executes it,
 * retrying with error feedback up to `maxRevisions` times on failure.
 *
 * @public
 * @param opts - Planner step, agent factories, optional constraints, max revision count, and step executor.
 * @returns A `Step` that adaptively plans and executes.
 */
export function adaptivePlan<O>(opts: {
  planner: Step<ContextMemory, string, PlanNode>;
  agents: Record<string, (prompt: string) => Step<ContextMemory, string, unknown>>;
  constraints?: PlanConstraints;
  maxRevisions: number;
  executeStep?: ExecuteStepFn;
}): Step<ContextMemory, string, O> {
  return {
    kind: 'run',
    id: 'adaptive-plan',
    execute: async (input: string, ctx: Context) => {
      let lastError: Error | null = null;

      for (let revision = 0; revision < opts.maxRevisions; revision++) {
        // Generate plan
        const planInput = lastError
          ? `${input}\n\nPrevious plan failed: ${lastError.message}`
          : input;
        let plan: PlanNode;
        if (opts.executeStep) {
          plan = PlanNodeSchema.parse(await opts.executeStep(opts.planner, planInput, ctx));
        } else if (opts.planner.kind === 'run') {
          plan = PlanNodeSchema.parse(await opts.planner.execute(planInput, ctx));
        } else {
          throw new Error('Planner must be a run step when no executeStep provided');
        }

        // Compile and execute
        try {
          const compiled = compilePlan<O>(plan, opts.agents, opts.constraints, opts.executeStep);
          if (opts.executeStep) {
            return frameworkCast<O>(await opts.executeStep(compiled, input, ctx));
          }
          if (compiled.kind === 'run') {
            return frameworkCast<O>(await compiled.execute(input, ctx));
          }
          throw new Error(
            `No executeStep provided and compiled plan kind '${compiled.kind}' cannot be executed directly`,
          );
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (revision === opts.maxRevisions - 1) {
            throw lastError;
          }
        }
      }

      throw lastError!;
    },
  };
}
