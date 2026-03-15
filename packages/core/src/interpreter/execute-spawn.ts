import { OrchidErrorImpl } from '../errors/orchid-error';
import { ContextImpl } from '../runtime/context-impl';
import type { Context } from '../types/context';
import type { Item } from '../types/items';
import type { ExecuteStepFn, StepSpawn } from '../types/step';
import { cloneWithGuard } from './clone-guard';
import type { CallModelFn } from './execute-llm';
import { createMessage, extractAssistantText } from './message-helpers';

export async function executeSpawn<I, O>(
  step: StepSpawn<I, O>,
  input: I,
  ctx: Context,
  executeStep: ExecuteStepFn,
  callModel?: CallModelFn,
): Promise<O> {
  // Build child context based on contextIn strategy
  let childItems: Item[] = [];

  switch (step.contextIn.strategy) {
    case 'inherit':
      childItems = [
        ...ctx.itemLog.items,
      ];
      break;
    case 'fresh':
      childItems = [];
      break;
    case 'subset':
      childItems = step.contextIn.select(
        [
          ...ctx.itemLog.items,
        ],
        ctx.state,
      );
      break;
    case 'custom':
      childItems = step.contextIn.build(input, ctx);
      break;
  }

  // Create child context with deep-cloned state
  const childCtx = new ContextImpl({
    parent: ctx,
    items: childItems,
    state: cloneWithGuard(ctx.state, `Spawn '${step.id}'`),
    threadId: ctx.threadId,
    resourceId: ctx.resourceId,
  });

  // Execute the child step
  const childOutput = await executeStep<I, O>(step.child, input, childCtx);

  // Handle contextOut strategy
  switch (step.contextOut.strategy) {
    case 'full':
      return childOutput;

    case 'summary': {
      if (!callModel) {
        throw new OrchidErrorImpl({
          kind: 'step_failed',
          stepId: step.id,
          cause: new Error('callModel required for summary contextOut'),
          retriesExhausted: false,
        });
      }
      const summaryModel = step.contextOut.model ?? 'gpt-4';
      const summaryPrompt = step.contextOut.prompt ?? 'Summarize the above conversation concisely.';

      childCtx.itemLog.append(createMessage(summaryPrompt, 'user'));

      try {
        const response = await callModel({
          model: summaryModel,
          items: childCtx.itemLog.items,
        });
        const text = extractAssistantText(response.items);
        // SAFETY: O is string for summary strategy — the summarization model returns text,
        // and callers using summary contextOut expect string output.
        return text as unknown as O;
      } catch (e) {
        throw new OrchidErrorImpl({
          kind: 'spawn_summary_failed',
          stepId: step.id,
          childOutput: childOutput,
          summaryCause: e instanceof Error ? e : new Error(String(e)),
        });
      }
    }

    case 'schema': {
      const parseResult = step.contextOut.schema.safeParse(childOutput);
      if (parseResult.success) {
        return parseResult.data;
      }
      throw new OrchidErrorImpl({
        kind: 'llm_parse_error',
        stepId: step.id,
        raw: JSON.stringify(childOutput),
        schema: step.contextOut.schema,
        zodError: parseResult.error,
      });
    }

    default: {
      const _exhaustive: never = step.contextOut;
      throw new OrchidErrorImpl({
        kind: 'step_failed',
        stepId: step.id,
        cause: new Error('Unknown contextOut strategy'),
        retriesExhausted: false,
      });
    }
  }
}
