/**
 * The tool-call pipeline shared by every caller that runs a Noetic tool on a
 * model's behalf: the `callModel` tool loop, and ACP agents calling bridged
 * tools over MCP. Keeping one copy is what makes the two behave the same.
 */

import type { ContextLayer } from '@noetic-tools/context';
import type {
  AgentHarnessContract,
  Context,
  HeldCall,
  Item,
  ItemSchemaRegistry,
  StandardSchemaV1,
  SteeringDecision,
  Tool,
  ToolHold,
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
import type { HeldRecord, HoldDue } from './held-calls';
import {
  HoldSignal,
  heldArgsHash,
  heldCallsOf,
  heldScopeOf,
  isOverdue,
  mayWriteHolds,
  toHeldCall,
} from './held-calls';
import type { ApprovalOutcome, ToolApproval } from './tool-approval';
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
  /**
   * The id the call's durable records go under: its held record, a `durable` tool's
   * intent, its idempotency key. Defaults to `callId`. A caller whose `callId` does
   * not survive a resume (an ACP agent makes the call again under a new id) gives
   * one that does.
   */
  recordId?: string;
}

/** The id a call's durable records go under. */
function recordIdOf(params: ExecuteToolCallParams): string | undefined {
  return params.recordId ?? params.callId;
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
  /**
   * Set when the call is held for a person (spec 08 § Held tool calls): it has no
   * result yet, and `output` is empty.
   */
  held?: HeldCall;
  /** The call was held and is now settled: its record can be dropped. */
  settled?: boolean;
  /**
   * A `durable` tool ran under an intent record. The caller drops it once the
   * result is on record; until then a resumed run treats the call as started.
   */
  armed?: boolean;
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

  // A call that was held got past these layers before it was held.
  const holds = heldCallsOf(params.harness);
  const scope = heldScopeOf(params.context);
  const recordId = recordIdOf(params);
  const prior = recordId === undefined ? undefined : await holds.load(scope, recordId);
  if (!prior && params.layers && params.layers.length > 0) {
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

  // A record for other arguments is for another call: this one starts over.
  const held = prior?.argsHash === heldArgsHash(matchedTool.name, parsedArgs) ? prior : undefined;
  const wasHeld = held !== undefined;
  // A person may answer an unknown outcome with "run it again".
  const rerun = held?.reason === 'outcome' && held.resolution?.action === SteeringAction.Allow;
  if (held && held.reason !== 'approval' && !rerun) {
    if (held.resolution?.hasOutput) {
      return {
        output: toolOutputText(held.resolution.output),
        result: held.resolution.output,
        settled: true,
      };
    }
    const refusal = held.resolution?.action;
    if (refusal !== undefined) {
      return {
        ...refusedResult({
          action: refusal,
          guidance: held.resolution?.guidance,
        }),
        settled: true,
      };
    }
    if (isOverdue(held, holds.now())) {
      return {
        output: `Error: nobody answered '${matchedTool.name}' before the hold ran out`,
        error: true,
        settled: true,
      };
    }
    return {
      output: '',
      held: toHeldCall(held),
    };
  }

  let approval: ToolApproval | undefined;
  try {
    // A call a person just said to run again was approved the first time it ran.
    approval =
      matchedTool.needsApproval && !rerun
        ? await askApproval({
            harness: params.harness,
            toolName: matchedTool.name,
            toolArgs: parsedArgs,
            callId: params.callId,
            recordId,
            ctx: params.context,
          })
        : undefined;
  } catch (e) {
    if (!(e instanceof HoldSignal) || recordId === undefined) {
      throw e;
    }
    return holdCall(params, {
      callId: recordId,
      tool: matchedTool,
      args: parsedArgs,
      reason: 'approval',
      due: e.due,
    });
  }
  if (approval && approval.decision.action !== SteeringAction.Allow) {
    return {
      ...refusedResult(approval.decision),
      approval: approval.outcome,
      settled: wasHeld,
    };
  }
  // A durable tool must not be repeated unasked. An intent record says it started;
  // finding one with no result means a host died while it ran, and only a person
  // can say whether its effect landed.
  const armed = matchedTool.durable === true && recordId !== undefined;
  if (armed && recordId !== undefined) {
    const argsHash = heldArgsHash(matchedTool.name, parsedArgs);
    if (!rerun && (await holds.wasStarted(scope, recordId, argsHash))) {
      return holdCall(params, {
        callId: recordId,
        tool: matchedTool,
        args: parsedArgs,
        reason: 'outcome',
        due: {},
      });
    }
    if (mayWriteHolds(params.context)) {
      if (rerun) {
        // Answered: if this attempt is cut off too, the question is asked afresh.
        await holds.close(scope, recordId);
      }
      await holds.arm(scope, recordId, argsHash);
    }
  }
  const executed = await runMatchedTool(params, matchedTool, parsedArgs);
  return {
    ...executed,
    approval: approval?.outcome,
    settled: wasHeld && !rerun && executed.held === undefined,
    armed,
  };
}

/** Write the record of a call that is now held, and report it as held. */
async function holdCall(
  params: ExecuteToolCallParams,
  call: {
    callId: string;
    tool: Tool;
    args: unknown;
    reason: 'approval' | 'result' | 'outcome';
    due: HoldDue;
    request?: unknown;
  },
): Promise<ToolCallResult> {
  // A harness that was replaced writes nothing; the call still reads as held, and
  // this turn is about to stop.
  const holds = heldCallsOf(params.harness);
  const open = mayWriteHolds(params.context)
    ? (record: HeldRecord) => holds.open(heldScopeOf(params.context), record)
    : async (record: HeldRecord) => record;
  const record = await open({
    callId: call.callId,
    name: call.tool.name,
    args: call.args,
    argsHash: heldArgsHash(call.tool.name, call.args),
    reason: call.reason,
    ...(call.due.dueAt === undefined
      ? {}
      : {
          dueAt: call.due.dueAt,
        }),
    ...(call.due.onDue === undefined
      ? {}
      : {
          onDue: call.due.onDue,
        }),
    ...(call.request === undefined
      ? {}
      : {
          request: call.request,
        }),
  });
  return {
    output: '',
    held: toHeldCall(record),
  };
}

/** True for what `hold()` returns: a tool leaving its result open. */
export function isToolHold(value: unknown): value is ToolHold {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'noetic/tool-hold'
  );
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
  const toolCtx = buildToolExecutionContext(params.context, params.harness, {
    callId: params.callId,
    recordId: recordIdOf(params),
  });
  const callId = params.callId;
  // Where the call's held record goes: the id that survives a resume.
  const holdId = recordIdOf(params);
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
    // The tool did its part and left the result for a person to give.
    if (isToolHold(result)) {
      if (holdId === undefined) {
        return {
          output: `Error: '${matchedTool.name}' cannot be held: the call has no id`,
          error: true,
        };
      }
      return holdCall(params, {
        callId: holdId,
        tool: matchedTool,
        args: parsedArgs,
        reason: 'result',
        due: {
          dueAt: result.dueAt,
          onDue: result.onDue,
        },
        request: result.request,
      });
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
    // An approval seam inside the tool (a connection's gates) held the call.
    if (e instanceof HoldSignal && holdId !== undefined) {
      return holdCall(params, {
        callId: holdId,
        tool: matchedTool,
        args: parsedArgs,
        reason: 'approval',
        due: e.due,
      });
    }
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
