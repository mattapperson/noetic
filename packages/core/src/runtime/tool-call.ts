/**
 * The tool-call pipeline shared by every caller that runs a Noetic tool on a
 * model's behalf: the `callModel` tool loop, and ACP agents calling bridged
 * tools over MCP. Keeping one copy is what makes the two behave the same.
 */

import type { ContextLayer } from '@noetic-tools/context';
import type {
  AgentHarnessContract,
  Context,
  Item,
  ItemSchemaRegistry,
  StandardSchemaV1,
  SteeringDecision,
  Tool,
} from '@noetic-tools/types';
import {
  frameworkCast,
  isStandardJsonSchema,
  isZodSchema,
  NoeticConfigError,
  SteeringAction,
  validateSchema,
} from '@noetic-tools/types';
import { z } from 'zod';
import { sanitizeToolNameForWire } from '../util/tool-name';
import type { ApprovalOutcome } from './tool-approval';
import { askApproval } from './tool-approval';
import { buildToolExecutionContext } from './tool-context';
import { emitToolUi } from './tool-ui';

//#region Wire names and schemas

/**
 * Resolve the JSON Schema sent to the model. Zod keeps its legacy-compatible
 * fast path. For other validators, an explicit override wins over the Standard
 * JSON Schema v1 companion trait.
 * @internal
 */
export function resolveWireJsonSchema(params: {
  schema: StandardSchemaV1;
  explicitJsonSchema?: Record<string, unknown>;
  what: string;
}): Record<string, unknown> {
  const { schema, explicitJsonSchema, what } = params;
  if (isZodSchema(schema)) {
    return sanitizeJsonSchema(
      z.toJSONSchema(schema, {
        target: 'draft-07',
      }),
    );
  }
  if (explicitJsonSchema) {
    return sanitizeJsonSchema(explicitJsonSchema);
  }
  if (isStandardJsonSchema(schema)) {
    try {
      return sanitizeJsonSchema(
        schema['~standard'].jsonSchema.input({
          target: 'draft-07',
        }),
      );
    } catch {
      // Fall through to the actionable configuration error below.
    }
  }
  throw new NoeticConfigError({
    code: 'MISSING_JSON_SCHEMA',
    message: `The ${what} cannot be converted to JSON Schema.`,
    hint: 'Use a schema implementing StandardJSONSchemaV1 or pass `inputJsonSchema` on tool() / `outputJsonSchema` on step.llm().',
  });
}

function sanitizeJsonSchema(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('~'))
      .map(([key, nested]) => [
        key,
        sanitizeJsonSchemaValue(nested),
      ]),
  );
}

function sanitizeJsonSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonSchemaValue);
  }
  if (typeof value === 'object' && value !== null) {
    return sanitizeJsonSchema(frameworkCast<Record<string, unknown>>(value));
  }
  return value;
}

//#endregion

//#region Execution

/** @internal */
export interface ExecuteToolCallParams {
  toolName: string;
  args: unknown;
  tools: ReadonlyArray<Tool>;
  context: Context;
  harness: AgentHarnessContract;
  layers?: ContextLayer[];
  /**
   * The call's id — the model's `function_call` id, or an ACP agent's own id
   * for a bridged call. Keys the tool-UI region and, through
   * `ToolExecutionContext.callId`, a connection tool's idempotency key.
   */
  callId?: string;
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Symbol.asyncIterator in value;
}

/** @internal What one model-requested tool call produced. */
export interface ToolCallResult {
  output: string;
  result?: unknown;
  error?: boolean;
  /** Set when the tool declares `needsApproval` and the call reached the approver. */
  approval?: ApprovalOutcome;
}

/**
 * @internal Execute a single tool call. Gates run in order: the
 * `beforeToolCall` layers, input validation, then — for a tool that declares
 * `needsApproval` — the harness approver. A refusal at any gate becomes an
 * error tool result; the tool never runs.
 */
export async function executeToolCall(params: ExecuteToolCallParams): Promise<ToolCallResult> {
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
      params.callId,
    );
    if (decision.action !== SteeringAction.Allow) {
      return refusedResult(decision);
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

  const approval = matchedTool.needsApproval
    ? await askApproval({
        harness: params.harness,
        toolName: matchedTool.name,
        toolArgs: parsedArgs,
        callId: params.callId,
        ctx: params.context,
      })
    : undefined;
  if (approval && approval.decision.action !== SteeringAction.Allow) {
    return {
      ...refusedResult(approval.decision),
      approval: approval.outcome,
    };
  }
  const executed = await runMatchedTool(params, matchedTool, parsedArgs);
  return {
    ...executed,
    approval: approval?.outcome,
  };
}

function refusedResult(decision: SteeringDecision): ToolCallResult {
  if (decision.action === SteeringAction.Guide) {
    return {
      output: `Tool call redirected: ${decision.guidance}`,
      error: true,
    };
  }
  return {
    output: `Tool call denied: ${decision.guidance ?? 'steering rule violation'}`,
    error: true,
  };
}

async function runMatchedTool(
  params: ExecuteToolCallParams,
  matchedTool: Tool,
  parsedArgs: unknown,
): Promise<ToolCallResult> {
  const toolCtx = buildToolExecutionContext(params.context, params.harness, params.callId);
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
      output: toolOutputText(result),
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

/**
 * The string a tool result reaches the model as. A tool with no result
 * (`undefined`, e.g. `output: z.void()`) reaches it as an empty string — a
 * result every provider and every MCP client accepts — rather than no output.
 */
function toolOutputText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  return JSON.stringify(result) ?? '';
}

//#endregion

//#region Result items

/**
 * Build and validate a `function_call_output` item for a tool result.
 *
 * `roundItemSchemas` must be the OWNER-SCOPED registry for the called tool
 * (harness base extended with only that tool's `itemSchemas`), so one tool's
 * `toolResults` schemas never reject a sibling tool's result items. Tools
 * without `itemSchemas` fall back to the base structural parse.
 */
export function createToolResultItem({
  output,
  callId,
  roundItemSchemas,
  tool,
  callItem,
  args,
  result,
  error,
}: {
  output: string;
  callId: string;
  roundItemSchemas: ItemSchemaRegistry;
  tool?: Tool;
  callItem?: Item;
  args?: unknown;
  result?: unknown;
  error?: boolean;
}): Item {
  const baseItem = {
    id: crypto.randomUUID(),
    status: 'completed',
    type: 'function_call_output',
    callId,
    output,
  } as const;
  const decorated =
    tool?.decorateResultItem && callItem?.type === 'function_call'
      ? tool.decorateResultItem({
          baseItem,
          callItem,
          args,
          result,
          output,
          error,
        })
      : baseItem;
  return roundItemSchemas.parseWithCategory(decorated, 'toolResults');
}

//#endregion
