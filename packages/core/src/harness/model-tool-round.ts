/**
 * The tool round of a model call: run each function call the model made (or
 * answer it unrun when a steer arrives first), append its result item to the
 * conversation, and record the tool span.
 */

import type {
  AgentHarnessContract,
  CallModelRequest,
  Context,
  FunctionCallItem,
  Item,
  ItemSchemaRegistry,
  Span,
  Tool,
} from '@noetic-tools/types';
import { SteerPoint } from '@noetic-tools/types';
import { itemsToInput } from '../adapters/openrouter';
import { isFunctionCall } from '../interpreter/typeguards';
import { drainsOf } from '../runtime/drain';
import { heldCallsOf, heldScopeOf, mayWriteHolds, waitOnHeldCalls } from '../runtime/held-calls';
import type { ApprovalOutcome } from '../runtime/tool-approval';
import { createToolResultItem, executeToolCall } from '../runtime/tool-call';
import type { CallSpanCollector } from './call-span-collector';
import type { PreparedModelRequest } from './model-request';
import { findTool } from './model-request';
import type { CallLedger } from './model-rounds';
import type { SteerInbox } from './steer-inbox';

//#region Types

/** What the tool round needs from the model caller that runs it. */
export interface ToolRoundScope {
  harness: AgentHarnessContract;
  itemSchemas: ItemSchemaRegistry;
  /** Broadcast a framework-authored item so the item stream carries it. */
  emitItemAppended: (ctx: Context | undefined, item: Item) => void;
}

//#endregion

//#region Tool Round

const SKIPPED_FOR_STEER_OUTPUT = 'Skipped: a new message arrived before this tool call ran.';

/**
 * Tool rounds replay only their function calls. A round a steer follows must
 * also replay what the model said, or the next round starts without it.
 * Function calls are left to the tool round, which adds each with its output.
 */
export function replayOutput(
  input: ReturnType<typeof itemsToInput>,
  roundItems: ReadonlyArray<Item>,
): void {
  input.push(...itemsToInput(roundItems.filter((item) => !isFunctionCall(item))));
}

/** How one function call of a round ended. */
interface FunctionCallOutcome {
  approval?: ApprovalOutcome;
  /** The call is held for a person and has no result yet. */
  held?: boolean;
}

/** Whether a round asked for any tool calls. */
export function hasFunctionCalls(roundItems: ReadonlyArray<Item>): boolean {
  return roundItems.some(isFunctionCall);
}

/** Run the round's function calls. Returns `false` when there were none to run. */
export async function runToolRound(
  scope: ToolRoundScope,
  params: {
    roundItems: Item[];
    request: CallModelRequest;
    prepared: PreparedModelRequest;
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    round: number;
    spans: CallSpanCollector;
    modelSpan: Span | null;
    steers: SteerInbox | undefined;
    /** Where the round's calls are recorded as they finish. */
    calls?: CallLedger;
  },
): Promise<boolean> {
  const functionCalls = params.roundItems.filter(isFunctionCall);
  if (functionCalls.length === 0 || !params.request.tools) {
    return false;
  }
  await executeToolRound(scope, {
    functionCalls,
    request: params.request,
    allowedTools: params.prepared.allowedTools,
    allItems: params.allItems,
    conversationInput: params.conversationInput,
    round: params.round,
    emitIfAllowed: params.prepared.emitIfAllowed,
    spans: params.spans,
    modelSpan: params.modelSpan,
    steers: params.steers,
    calls: params.calls,
  });
  return true;
}

async function executeToolRound(
  scope: ToolRoundScope,
  params: {
    functionCalls: Extract<
      Item,
      {
        type: 'function_call';
      }
    >[];
    request: CallModelRequest;
    allowedTools: Tool[];
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    round: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
    spans: CallSpanCollector;
    modelSpan: Span | null;
    steers: SteerInbox | undefined;
    calls?: CallLedger;
  },
): Promise<void> {
  const {
    functionCalls,
    request,
    allowedTools,
    allItems,
    conversationInput,
    spans,
    modelSpan,
    steers,
  } = params;
  params.emitIfAllowed('tool_round_started', {
    round: params.round,
    toolCount: functionCalls.length,
  });
  for (const fc of functionCalls) {
    conversationInput.push({
      type: 'function_call',
      callId: fc.callId,
      // Derived, so a resumed round sends the id it sent before.
      id: fc.id ?? `fc_${fc.callId}`,
      name: fc.name,
      arguments: fc.arguments,
    });
  }
  const heldCalls: FunctionCallItem[] = [];
  for (const [index, fc] of functionCalls.entries()) {
    await drainsOf(request.ctx)?.hold(request.ctx);
    if (request.signal?.aborted) {
      break;
    }
    const remaining = functionCalls.slice(index);
    // A call an earlier attempt finished is not up for skipping: it already ran.
    const finished = params.calls?.take(fc) !== undefined;
    if (
      !finished &&
      steers?.hasQueued() &&
      (await steers.offer(SteerPoint.BeforeToolCall, remaining))
    ) {
      await dropHolds(scope, request, remaining);
      for (const skipped of remaining) {
        recordSkippedToolCall(scope, {
          fc: skipped,
          request,
          allowedTools,
          allItems,
          conversationInput,
          emitIfAllowed: params.emitIfAllowed,
        });
      }
      break;
    }
    const toolForCall = findTool(allowedTools, fc.name);
    const call = await executeFunctionCall(scope, {
      fc,
      request,
      allowedTools,
      allItems,
      conversationInput,
      emitIfAllowed: params.emitIfAllowed,
      calls: params.calls,
    });
    if (call.held) {
      heldCalls.push(fc);
      continue;
    }
    spans.recordToolSpan(modelSpan, fc.name, toolForCall?.needsApproval ?? false, call.approval);
  }
  // Calls held for a person: the round goes no further until each has an answer.
  while (heldCalls.length > 0) {
    // A message that arrives while calls are held is a steer like any other: the
    // context layers decide. Applied, the held calls are skipped and the round goes on.
    if (steers?.hasQueued() && (await steers.offer(SteerPoint.Held, heldCalls))) {
      await dropHolds(scope, request, heldCalls);
      for (const skipped of heldCalls.splice(0)) {
        recordUnrunToolCall(scope, {
          fc: skipped,
          output: SKIPPED_FOR_STEER_OUTPUT,
          request,
          allowedTools,
          allItems,
          conversationInput,
          emitIfAllowed: params.emitIfAllowed,
        });
      }
      break;
    }
    if (!request.ctx) {
      throw new Error('A held tool call needs a context to wait on.');
    }
    await waitOnHeldCalls({
      harness: scope.harness,
      ctx: request.ctx,
      callIds: heldCalls.map((fc) => fc.callId),
      signal: request.signal,
    });
    for (const fc of heldCalls.splice(0)) {
      const toolForCall = findTool(allowedTools, fc.name);
      const call = await executeFunctionCall(scope, {
        fc,
        request,
        allowedTools,
        allItems,
        conversationInput,
        emitIfAllowed: params.emitIfAllowed,
        calls: params.calls,
        announced: true,
      });
      if (call.held) {
        heldCalls.push(fc);
        continue;
      }
      spans.recordToolSpan(modelSpan, fc.name, toolForCall?.needsApproval ?? false, call.approval);
    }
  }
  params.emitIfAllowed('tool_round_completed', {
    round: params.round,
    toolCount: functionCalls.length,
  });
}

async function executeFunctionCall(
  scope: ToolRoundScope,
  params: {
    fc: Extract<
      Item,
      {
        type: 'function_call';
      }
    >;
    request: CallModelRequest;
    allowedTools: Tool[];
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
    calls?: CallLedger;
    /** The call was held and is being looked at again: its start was already announced. */
    announced?: boolean;
  },
): Promise<FunctionCallOutcome> {
  const { fc, request, allowedTools, allItems, conversationInput } = params;
  if (!params.announced) {
    params.emitIfAllowed('tool_call_started', {
      name: fc.name,
      callId: fc.callId,
    });
  }
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(fc.arguments);
  } catch {
    recordUnrunToolCall(scope, {
      fc,
      output: `Error: malformed JSON in tool arguments: ${fc.arguments}`,
      request,
      allowedTools,
      allItems,
      conversationInput,
      emitIfAllowed: params.emitIfAllowed,
    });
    return {};
  }
  if (!request.tools) {
    throw new Error(
      `executeFunctionCall invoked without tools on CallModelRequest (tool name: ${fc.name}).`,
    );
  }
  const toolForCall = findTool(allowedTools, fc.name);
  // An earlier attempt of this round may have finished this call: go on with what
  // it produced instead of running the tool again.
  // A durable tool's call marks its model step as having had a lasting effect.
  if (toolForCall?.durable === true) {
    // Under the round, which is what gets recorded: a note at the step's own path
    // would mark nothing until the whole step finished.
    params.calls?.noteEffect(fc);
  }
  // A tool that opts out of recording (`durable: false`) always runs again.
  const keeps = toolForCall?.durable !== false;
  const recorded = keeps ? params.calls?.take(fc) : undefined;
  const toolResult =
    recorded ??
    (await executeToolCall({
      toolName: fc.name,
      args: parsedArgs,
      tools: allowedTools,
      context: request.ctx,
      harness: scope.harness,
      layers: request.layers,
      callId: fc.callId,
    }));
  // Held: it has no result yet. Nothing goes into the conversation for it.
  if (toolResult.held) {
    if (!params.announced) {
      params.emitIfAllowed('tool_call_held', {
        ...toolResult.held,
      });
    }
    return {
      held: true,
    };
  }
  const stored = recorded || !keeps ? undefined : await params.calls?.record(fc, toolResult);
  // The intent of a durable call is dropped once its result is on record. A result
  // that could not be recorded keeps it, so a resume asks rather than runs again.
  const writes = request.ctx !== undefined && mayWriteHolds(request.ctx);
  if (toolResult.armed && stored !== false && writes) {
    await heldCallsOf(scope.harness).disarm(heldScopeOf(request.ctx), fc.callId);
  }
  if (toolResult.settled && writes) {
    await heldCallsOf(scope.harness).close(heldScopeOf(request.ctx), fc.callId);
  }
  // Owner-scoped result validation: a tool's `toolResults` schemas apply
  // only to that tool's own result items. Harness-level `opts.itemSchemas`
  // stay global by design; sibling tools' schemas never reject this item.
  const outputItem = createToolResultItem({
    output: toolResult.output,
    callId: fc.callId,
    roundItemSchemas: scope.itemSchemas.extend(toolForCall?.itemSchemas),
    tool: toolForCall,
    callItem: fc,
    args: parsedArgs,
    result: toolResult.result,
    error: toolResult.error,
  });
  allItems.push(outputItem);
  conversationInput.push({
    type: 'function_call_output',
    callId: fc.callId,
    output: toolResult.output,
  });
  scope.emitItemAppended(request.ctx, outputItem);
  params.emitIfAllowed('tool_call_completed', {
    name: fc.name,
    callId: fc.callId,
    error: toolResult.error === true,
    output: toolResult.output,
    ...(recorded
      ? {
          replayed: true,
        }
      : {}),
  });
  return {
    approval: toolResult.approval,
  };
}

/** Drop the records of calls that are being skipped, so none stays listed as held. */
async function dropHolds(
  scope: ToolRoundScope,
  request: CallModelRequest,
  calls: ReadonlyArray<FunctionCallItem>,
): Promise<void> {
  if (!request.ctx || !mayWriteHolds(request.ctx)) {
    return;
  }
  const holds = heldCallsOf(scope.harness);
  const executionId = heldScopeOf(request.ctx);
  for (const call of calls) {
    if (await holds.load(executionId, call.callId)) {
      await holds.close(executionId, call.callId);
    }
  }
}

function recordSkippedToolCall(
  scope: ToolRoundScope,
  params: {
    fc: FunctionCallItem;
    request: CallModelRequest;
    allowedTools: Tool[];
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  },
): void {
  params.emitIfAllowed('tool_call_started', {
    name: params.fc.name,
    callId: params.fc.callId,
  });
  recordUnrunToolCall(scope, {
    ...params,
    output: SKIPPED_FOR_STEER_OUTPUT,
  });
}

/** Answer a call that never ran, so every call in the history has an output. */
function recordUnrunToolCall(
  scope: ToolRoundScope,
  params: {
    fc: FunctionCallItem;
    output: string;
    request: CallModelRequest;
    allowedTools: Tool[];
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  },
): void {
  const { fc, request, allowedTools, allItems, conversationInput } = params;
  const toolForCall = findTool(allowedTools, fc.name);
  // Owner-scoped result validation (see executeFunctionCall).
  const outputItem = createToolResultItem({
    output: params.output,
    callId: fc.callId,
    roundItemSchemas: scope.itemSchemas.extend(toolForCall?.itemSchemas),
    tool: toolForCall,
    callItem: fc,
    error: true,
  });
  allItems.push(outputItem);
  conversationInput.push({
    type: 'function_call_output',
    callId: fc.callId,
    output: params.output,
  });
  scope.emitItemAppended(request.ctx, outputItem);
  params.emitIfAllowed('tool_call_completed', {
    name: fc.name,
    callId: fc.callId,
    error: true,
    output: params.output,
  });
}

//#endregion
