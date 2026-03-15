import type { StepSpawn } from '../types/step';
import type { Context } from '../types/context';
import type { CallModelFn } from './execute-llm';
import type { MessageItem } from '../types/items';
import { ContextImpl } from '../runtime/context-impl';
import { OrchidErrorImpl } from '../errors/orchid-error';

export type ExecuteStepFn = <I, O>(step: any, input: I, ctx: Context) => Promise<O>;

export async function executeSpawn<I, O>(
  step: StepSpawn<I, O>,
  input: I,
  ctx: Context,
  executeStep: ExecuteStepFn,
  callModel?: CallModelFn,
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

    case 'summary': {
      if (!callModel) throw new Error('callModel required for summary contextOut');
      const summaryModel = step.contextOut.model ?? 'gpt-4';
      const summaryPrompt = step.contextOut.prompt ?? 'Summarize the above conversation concisely.';

      // Add a user message asking for summary
      childCtx.itemLog.append({
        id: crypto.randomUUID(),
        status: 'completed',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: summaryPrompt }],
      } as MessageItem);

      try {
        const response = await callModel(summaryModel, childCtx.itemLog.items);
        const lastMsg = [...response.items]
          .reverse()
          .find((i: any) => i.type === 'message' && i.role === 'assistant');
        const text =
          (lastMsg as any)?.content
            ?.filter((c: any) => c.type === 'output_text')
            ?.map((c: any) => c.text)
            ?.join('') ?? '';
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
        return parseResult.data as O;
      }
      throw new OrchidErrorImpl({
        kind: 'llm_parse_error',
        stepId: step.id,
        raw: JSON.stringify(childOutput),
        schema: step.contextOut.schema,
        zodError: parseResult.error,
      });
    }

    default:
      throw new Error(`Unknown contextOut strategy: ${(step.contextOut as any).strategy}`);
  }
}
