import type { StepSpawn } from '../types/step';
import type { Context } from '../types/context';
import type { CallModelFn } from './execute-llm';
import type { Item, MessageItem } from '../types/items';
import { ContextImpl } from '../runtime/context-impl';
import { OrchidErrorImpl } from '../errors/orchid-error';
import { isContextImpl, isAssistantMessage, isOutputText } from './typeguards';
import { cloneWithGuard } from './clone-guard';

import type { Step } from '../types/step';

export type ExecuteStepFn = <I, O>(step: Step<I, O>, input: I, ctx: Context) => Promise<O>;

function createUserMessage(text: string): MessageItem {
  return {
    id: crypto.randomUUID(),
    status: 'completed',
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

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
    state: cloneWithGuard(ctx.state, `Spawn '${step.id}'`),
    threadId: isContextImpl(ctx) ? ctx.threadId : crypto.randomUUID(),
    resourceId: isContextImpl(ctx) ? ctx.resourceId : undefined,
  });

  // Execute the child step
  const childOutput = await executeStep<I, O>(step.child, input, childCtx);

  // Handle contextOut strategy
  switch (step.contextOut.strategy) {
    case 'full':
      return childOutput;

    case 'summary': {
      if (!callModel) throw new OrchidErrorImpl({
        kind: 'step_failed',
        stepId: step.id,
        cause: new Error('callModel required for summary contextOut'),
        retriesExhausted: false,
      });
      const summaryModel = step.contextOut.model ?? 'gpt-4';
      const summaryPrompt = step.contextOut.prompt ?? 'Summarize the above conversation concisely.';

      childCtx.itemLog.append(createUserMessage(summaryPrompt));

      try {
        const response = await callModel(summaryModel, childCtx.itemLog.items);
        const lastMsg = [...response.items]
          .reverse()
          .find(isAssistantMessage);
        const text = lastMsg?.content
          ?.filter(isOutputText)
          ?.map((c) => c.text)
          ?.join('') ?? '';
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- design: summary text returned as O
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
