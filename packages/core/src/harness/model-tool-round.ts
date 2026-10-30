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
import { executeToolCall, itemsToInput } from '../adapters/openrouter';
import { isFunctionCall } from '../interpreter/typeguards';
import { drainsOf } from '../runtime/drain';
import type { ApprovalOutcome } from '../runtime/tool-approval';
import type { CallSpanCollector } from './call-span-collector';
import type { PreparedModelRequest } from './model-request';
import { findTool } from './model-request';
import { createToolResultItem } from './model-schema.js';
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
      id: fc.id ?? crypto.randomUUID(),
      name: fc.name,
      arguments: fc.arguments,
    });
  }
  for (const [index, fc] of functionCalls.entries()) {
    await drainsOf(request.ctx)?.hold(request.ctx);
    if (request.signal?.aborted) {
      break;
    }
    const remaining = functionCalls.slice(index);
    if (steers?.hasQueued() && (await steers.offer(SteerPoint.BeforeToolCall, remaining))) {
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
    const approval = await executeFunctionCall(scope, {
      fc,
      request,
      allowedTools,
      allItems,
      conversationInput,
      emitIfAllowed: params.emitIfAllowed,
    });
    spans.recordToolSpan(modelSpan, fc.name, toolForCall?.needsApproval ?? false, approval);
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
  },
): Promise<ApprovalOutcome | undefined> {
  const { fc, request, allowedTools, allItems, conversationInput } = params;
  params.emitIfAllowed('tool_call_started', {
    name: fc.name,
    callId: fc.callId,
  });
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
    return undefined;
  }
  if (!request.tools) {
    throw new Error(
      `executeFunctionCall invoked without tools on CallModelRequest (tool name: ${fc.name}).`,
    );
  }
  const toolForCall = findTool(allowedTools, fc.name);
  const toolResult = await executeToolCall({
    toolName: fc.name,
    args: parsedArgs,
    tools: allowedTools,
    context: request.ctx,
    harness: scope.harness,
    layers: request.layers,
    callId: fc.callId,
  });
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
  });
  return toolResult.approval;
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
