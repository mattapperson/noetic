import type { StepSpawn } from '../types/step';
import type { Context } from '../types/context';
import { ContextImpl } from '../runtime/context-impl';

export type ExecuteStepFn = <I, O>(step: any, input: I, ctx: Context) => Promise<O>;

export async function executeSpawn<I, O>(
  step: StepSpawn<I, O>,
  input: I,
  ctx: Context,
  executeStep: ExecuteStepFn,
): Promise<O> {
  // Build child context based on contextIn strategy
  let childItems: any[] = [];

  switch (step.contextIn.strategy) {
    case 'inherit':
      childItems = [...ctx.itemLog.items];
      break;
    case 'fresh':
      childItems = [];
      break;
    case 'subset':
      childItems = step.contextIn.select([...ctx.itemLog.items], ctx.state);
      break;
    case 'custom':
      childItems = step.contextIn.build(input, ctx);
      break;
  }

  // Create child context with deep-cloned state
  const childCtx = new ContextImpl({
    parent: ctx,
    items: childItems,
    state: structuredClone(ctx.state),
    threadId: (ctx as any).threadId,
    resourceId: (ctx as any).resourceId,
  });

  // Execute the child step
  const childOutput = await executeStep<I, O>(step.child, input, childCtx);

  // Handle contextOut strategy
  switch (step.contextOut.strategy) {
    case 'full':
      return childOutput;
    case 'summary':
      // Will be implemented in Stage 5
      throw new Error('Summary contextOut not yet implemented');
    case 'schema':
      // Will be implemented in Stage 5
      throw new Error('Schema contextOut not yet implemented');
    default:
      throw new Error(`Unknown contextOut strategy: ${(step.contextOut as any).strategy}`);
  }
}
