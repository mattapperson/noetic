import { NoeticErrorImpl } from '../errors/noetic-error';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import { buildToolExecutionContext } from '../runtime/tool-memory';
import type { Context } from '../types/context';
import type { ContextMemory, MemoryLayer } from '../types/memory';
import type { AgentHarnessContract } from '../types/runtime';
import { SteeringAction } from '../types/steering';
import type { StepTool } from '../types/step';
import { frameworkCast } from '../util/framework-cast';

//#region Helpers

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Symbol.asyncIterator in value;
}

async function consumeToolGenerator(params: {
  generator: AsyncGenerator<unknown, unknown>;
  stepId: string;
  toolName: string;
  ctx: Context<ContextMemory>;
}): Promise<unknown> {
  const broadcaster = getBroadcaster(params.ctx);
  const agentName = params.ctx.harness.config.name;

  while (true) {
    const next = await params.generator.next();
    if (next.done) {
      return next.value;
    }

    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'tool_progress',
      data: {
        stepId: params.stepId,
        toolName: params.toolName,
        event: next.value,
      },
    });
  }
}

//#endregion

//#region Public API

export async function executeTool<TMemory, I, O>(
  step: StepTool<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  harness: AgentHarnessContract,
  layers?: MemoryLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);
  const args = step.args ? Object.assign({}, input, step.args) : input;

  const parseResult = step.tool.input.safeParse(args);
  if (!parseResult.success) {
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(`Tool input validation failed: ${parseResult.error.message}`),
      retriesExhausted: false,
    });
  }

  if (layers && layers.length > 0) {
    const decision = await harness.beforeToolCall(
      layers,
      step.tool.name,
      parseResult.data,
      baseCtx,
    );
    if (decision.action !== SteeringAction.Allow) {
      throw new NoeticErrorImpl({
        kind: 'steering_denied',
        guidance: decision.guidance,
      });
    }
  }

  try {
    const toolCtx = buildToolExecutionContext(baseCtx, harness);
    const result = step.tool.execute(parseResult.data, toolCtx);

    if (isAsyncGenerator(result)) {
      return frameworkCast<O>(
        await consumeToolGenerator({
          generator: result,
          stepId: step.id,
          toolName: step.tool.name,
          ctx: baseCtx,
        }),
      );
    }

    return frameworkCast<O>(await result);
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

//#endregion
