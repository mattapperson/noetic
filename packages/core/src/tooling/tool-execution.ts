/**
 * The shared tool-execution path: one function every tool dispatch goes
 * through — the model tool-loop (`harness/model-call`), interpreter actions,
 * and hydrated JSON-workflow `invokeTool` nodes — so a tool call always gets
 * the same gates regardless of who issued it: steering (`beforeToolCall`),
 * argument validation against the tool's input schema, the real layer bridge
 * from `buildToolExecutionContext`, and tool-UI emission.
 *
 * It lives in `tooling/` (below the interpreter/runtime/builders layers)
 * because the JSON workflow hydrator in `builders/` must reach it: a
 * workflow document's args are opaque JSON and may be model-generated, so
 * calling `tool.execute` directly from the hydrator would be a validation
 * and steering bypass.
 */

import type { ContextLayer } from '@noetic-tools/context';
import type { AgentHarnessContract, Context, Tool } from '@noetic-tools/types';
import { SteeringAction, validateSchema } from '@noetic-tools/types';
import { buildToolExecutionContext } from './tool-context';
import { sanitizeToolNameForWire } from './tool-name';
import { emitToolUi } from './tool-ui';

/** @internal */
export interface ExecuteToolCallParams {
  toolName: string;
  args: unknown;
  tools: ReadonlyArray<Tool>;
  context: Context;
  harness: AgentHarnessContract;
  layers?: ContextLayer[];
  /** The model's `function_call` id — keys this call's tool-UI region. */
  callId?: string;
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Symbol.asyncIterator in value;
}

/** @internal Execute a single tool call with steering checks. */
export async function executeToolCall(params: ExecuteToolCallParams): Promise<{
  output: string;
  result?: unknown;
  error?: boolean;
}> {
  // Model sees sanitised tool names (see `sanitizeToolNameForWire`). Match
  // against both the original and sanitised name so internal identity (e.g.
  // `plan/updatePrd` used by steering whitelists, skill docs, and the
  // `plan()` layer's `beforeToolCall` hook) stays intact while the wire name is
  // provider-compliant.
  const matchedTool = params.tools.find(
    (t) => t.name === params.toolName || sanitizeToolNameForWire(t.name) === params.toolName,
  );
  if (!matchedTool) {
    return {
      output: `Error: unknown tool '${params.toolName}'`,
      error: true,
    };
  }

  if (params.layers && params.layers.length > 0) {
    const decision = await params.harness.beforeToolCall(
      params.layers,
      params.toolName,
      params.args,
      params.context,
    );
    if (decision.action === SteeringAction.Deny) {
      return {
        output: `Tool call denied: ${decision.guidance ?? 'steering rule violation'}`,
        error: true,
      };
    }
    if (decision.action === SteeringAction.Guide) {
      return {
        output: `Tool call redirected: ${decision.guidance}`,
        error: true,
      };
    }
  }

  const validated = await validateSchema(matchedTool.input, params.args);
  if (!validated.success) {
    return {
      output: `Error: invalid arguments for tool '${params.toolName}': ${validated.zodError.message}`,
      error: true,
    };
  }
  const parsedArgs = validated.value;

  const toolCtx = buildToolExecutionContext(params.context, params.harness);
  const callId = params.callId;
  const uiBase =
    callId !== undefined
      ? {
          ctx: params.context,
          tool: matchedTool,
          callId,
          args: parsedArgs,
        }
      : undefined;
  if (uiBase) {
    emitToolUi({
      ...uiBase,
      phase: 'call',
    });
  }
  try {
    const executionResult = matchedTool.execute(parsedArgs, toolCtx);
    // Generator tools stream progress; drive them here so tool-UI `progress`
    // fragments emit per yield (the non-UI case just consumes to the return).
    let result: unknown;
    if (isAsyncGenerator(executionResult)) {
      const events: unknown[] = [];
      for (;;) {
        const next = await executionResult.next();
        if (next.done) {
          result = next.value;
          break;
        }
        events.push(next.value);
        if (uiBase) {
          emitToolUi({
            ...uiBase,
            phase: 'progress',
            events,
          });
        }
      }
    } else {
      result = await executionResult;
    }
    if (uiBase) {
      emitToolUi({
        ...uiBase,
        phase: 'result',
        output: result,
      });
    }
    return {
      output: typeof result === 'string' ? result : JSON.stringify(result),
      result,
    };
  } catch (e) {
    if (uiBase) {
      emitToolUi({
        ...uiBase,
        phase: 'error',
        error: e,
      });
    }
    return {
      output: `Error: ${e instanceof Error ? e.message : String(e)}`,
      error: true,
    };
  }
}
