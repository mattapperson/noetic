import type { Step } from '../types/step';
import type { Context } from '../types/context';
import type { CallModelFn } from './execute-llm';
import { executeRun } from './execute-run';
import { executeLLM } from './execute-llm';
import { executeTool } from './execute-tool';

export async function execute<I, O>(
  step: Step<I, O>,
  input: I,
  ctx: Context,
  callModel?: CallModelFn,
): Promise<O> {
  // Increment step count
  (ctx as any).stepCount = (ctx.stepCount || 0) + 1;

  switch (step.kind) {
    case 'run':
      return executeRun(step, input, ctx);
    case 'llm':
      if (!callModel) throw new Error('callModel is required for LLM steps');
      return executeLLM(step, input, ctx, callModel);
    case 'tool':
      return executeTool(step, input, ctx);
    case 'branch':
      // Will be implemented in Stage 6
      throw new Error('Branch not yet implemented');
    case 'fork':
      // Will be implemented in Stage 2
      throw new Error('Fork not yet implemented');
    case 'spawn':
      // Will be implemented in Stage 3
      throw new Error('Spawn not yet implemented');
    case 'loop': {
      // Import executeLoop dynamically to avoid circular dependency
      const { executeLoop } = await import('./execute-loop');
      return executeLoop(step, input, ctx, (s, i, c) => execute(s, i, c, callModel));
    }
    default:
      throw new Error(`Unknown step kind: ${(step as any).kind}`);
  }
}
