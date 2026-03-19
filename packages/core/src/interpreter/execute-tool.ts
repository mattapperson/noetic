import { NoeticErrorImpl } from '../errors/noetic-error';
import { buildToolExecutionContext } from '../runtime/tool-memory';
import type { Context } from '../types/context';
import type { MemoryLayer } from '../types/memory';
import type { Runtime } from '../types/runtime';
import { SteeringAction } from '../types/steering';
import type { StepTool } from '../types/step';

export async function executeTool<I, O>(
  step: StepTool<I, O>,
  input: I,
  ctx: Context,
  runtime: Runtime,
  layers?: MemoryLayer[],
): Promise<O> {
  // Merge step.args with input (step.args takes precedence as overrides, input as base)
  const args = step.args ? Object.assign({}, input, step.args) : input;

  // Validate input against tool's schema
  const parseResult = step.tool.input.safeParse(args);
  if (!parseResult.success) {
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(`Tool input validation failed: ${parseResult.error.message}`),
      retriesExhausted: false,
    });
  }

  // Check steering layers before tool execution.
  // Note: LLM-dispatched tool calls are steered in the adapter (openrouter.ts convertTools).
  // This check covers StepTool steps invoked directly via the interpreter.
  if (layers && layers.length > 0) {
    const decision = await runtime.beforeToolCall(layers, step.tool.name, parseResult.data, ctx);
    if (decision.action !== SteeringAction.Allow) {
      throw new NoeticErrorImpl({
        kind: 'steering_denied',
        guidance: decision.guidance,
      });
    }
  }

  // Execute the tool
  try {
    const toolCtx = buildToolExecutionContext(ctx, runtime);
    const result = await step.tool.execute(parseResult.data, toolCtx);
    return result;
  } catch (e) {
    if (e instanceof NoeticErrorImpl) {
      throw e;
    }
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: e instanceof Error ? e : new Error(String(e)),
      retriesExhausted: false,
    });
  }
}
