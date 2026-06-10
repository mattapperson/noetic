import type {
  AgentHarnessContract,
  CallModelRequest,
  Context,
  InputMessageItem,
  Item,
  ItemSchemaRegistry,
  LLMResponse,
  Tool,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import type * as OpenRouterAgent from '@openrouter/agent';
import type { OpenRouter } from '@openrouter/agent';
import type { ZodType } from 'zod';
import { z } from 'zod';
import {
  convertTools,
  executeToolCall,
  extractOutputItems,
  extractSystemInstruction,
  extractUsage,
  itemsToInput,
  sanitizeToolNameForWire,
} from '../adapters/openrouter';
import { isFunctionCall } from '../interpreter/typeguards';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from '../runtime/broadcaster-utils';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import type { MessageQueue, QueuedMessage } from '../runtime/message-queue';
import { buildItemSchemaRegistry, createToolResultItem } from './model-schema.js';

const MAX_TOOL_ROUNDS = 32;
const MAX_RECOVERY_CONTINUATIONS = 3;
const EPHEMERAL_CONTINUE_INPUT = 'continue';

function buildTextFormat(schema: ZodType): {
  format: {
    type: 'json_schema';
    name: string;
    schema: Record<string, unknown>;
  };
} {
  const jsonSchema = z.toJSONSchema(schema);
  return {
    format: {
      type: 'json_schema',
      name: 'output',
      schema: jsonSchema,
    },
  };
}

function isStreamRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface ProviderTerminalError {
  status: string;
  message: string;
}

function providerTerminalError(response: unknown): ProviderTerminalError | null {
  if (!isStreamRecord(response) || response.status === undefined) {
    return null;
  }
  const status = String(response.status);
  if (status === 'completed') {
    return null;
  }
  if (status === 'incomplete') {
    const details = response.incompleteDetails;
    const reason =
      isStreamRecord(details) && typeof details.reason === 'string' ? `: ${details.reason}` : '';
    return {
      status,
      message: `LLM response incomplete${reason}`,
    };
  }
  if (status === 'failed') {
    const error = response.error;
    const message =
      isStreamRecord(error) && typeof error.message === 'string' ? `: ${error.message}` : '';
    return {
      status,
      message: `LLM response failed${message}`,
    };
  }
  return {
    status,
    message: `LLM response ended with status '${status}'`,
  };
}

function hasUsableResponseOutput(response: unknown, items: ReadonlyArray<Item>): boolean {
  if (items.length > 0) {
    return true;
  }
  return (
    isStreamRecord(response) &&
    typeof response.outputText === 'string' &&
    response.outputText.length > 0
  );
}

function withEphemeralContinueInput(
  input: ReturnType<typeof itemsToInput>,
): OpenRouterAgent.Item[] {
  return [
    ...frameworkCast<OpenRouterAgent.Item[]>(input),
    frameworkCast<OpenRouterAgent.Item>({
      type: 'message',
      role: 'user',
      content: EPHEMERAL_CONTINUE_INPUT,
    }),
  ];
}

/** Race a promise against an AbortSignal so callers (e.g. `SessionRunner.abort`)
 *  can break out of a long `await` without waiting for the underlying call to
 *  settle. When the signal fires, the returned promise rejects with
 *  `signal.reason` (an `Error`) or a generic `Error('aborted')` fallback. */
function awaitWithAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return p;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, {
      once: true,
    });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

interface PipeStreamOpts {
  stream: AsyncIterable<unknown>;
  /** Optional: when provided, each SDK event is emitted into it. Absent in
   *  headless/test harness runs that still need the idle watchdog to reset. */
  broadcaster?: EventBroadcaster;
  agentName: string;
  signal?: AbortSignal;
  /** Invoked once per SDK event received — used by the idle watchdog to bump
   *  its deadline so a still-streaming response isn't aborted. */
  onEvent?: () => void;
}

async function pipeStreamEventsToBroadcaster(opts: PipeStreamOpts): Promise<void> {
  const { stream, broadcaster, agentName, signal, onEvent } = opts;
  try {
    for await (const event of stream) {
      if (signal?.aborted) {
        return;
      }
      onEvent?.();
      if (!isStreamRecord(event)) {
        continue;
      }
      broadcaster?.emit({
        source: 'sdk',
        type: typeof event.type === 'string' ? event.type : 'unknown',
        data: event,
        outputIndex: typeof event.outputIndex === 'number' ? event.outputIndex : undefined,
        contentIndex: typeof event.contentIndex === 'number' ? event.contentIndex : undefined,
      });
    }
  } catch (err: unknown) {
    if (broadcaster) {
      emitFrameworkEvent({
        broadcaster,
        agentName,
        eventType: 'stream_pipe_error',
        data: {
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    throw err;
  }
}

interface StreamIdleWatchdog {
  /** Bump the deadline because a stream event just arrived. */
  reset: () => void;
  /** Clear the pending timer. Safe to call multiple times. */
  stop: () => void;
}

/** @internal Create a watchdog that aborts `controller` when no
 *  {@link StreamIdleWatchdog.reset reset} is called within `timeoutMs`. When
 *  `timeoutMs <= 0`, returns an inert no-op so callers can always call `.reset()`
 *  / `.stop()` without a branch. Starts armed: the caller is responsible for
 *  `.stop()` in a `finally`. `onTimeout` runs before the abort so observers can
 *  emit a framework event with the original cause. Exported only for unit tests. */
export function createStreamIdleWatchdog(
  timeoutMs: number,
  controller: AbortController,
  onTimeout?: () => void,
): StreamIdleWatchdog {
  if (timeoutMs <= 0) {
    return {
      reset: () => {},
      stop: () => {},
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = (): void => {
    timer = setTimeout(() => {
      if (stopped) {
        return;
      }
      const reason = new Error(`llm stream idle timeout after ${timeoutMs}ms`);
      onTimeout?.();
      controller.abort(reason);
    }, timeoutMs);
  };
  arm();
  return {
    reset: () => {
      if (stopped || !timer) {
        return;
      }
      clearTimeout(timer);
      arm();
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** @internal Context carries the session queue reference so callModel can
 *  inject between-rounds messages into the current tool-round loop. */
export interface SessionCtxExtension {
  _sessionQueue?: MessageQueue;
  _sessionBetweenRounds?: boolean;
  _sessionRunnerAgentName?: string;
}

function hasSessionQueue(ctx: Context): ctx is Context & Required<SessionCtxExtension> {
  const maybe = frameworkCast<Context & SessionCtxExtension>(ctx);
  return (
    maybe._sessionBetweenRounds === true &&
    maybe._sessionQueue !== undefined &&
    typeof maybe._sessionRunnerAgentName === 'string'
  );
}

//#endregion

interface PreparedModelRequest {
  instructions?: string;
  remaining: ReadonlyArray<Item>;
  broadcaster?: EventBroadcaster;
  sdkTools?: ReturnType<typeof convertTools>;
  emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
}

function prepareModelRequest(request: CallModelRequest, agentName: string): PreparedModelRequest {
  const { instructions: extractedInstructions, remaining } = extractSystemInstruction(
    request.items,
  );
  const instructions =
    [
      request.instructions,
      extractedInstructions,
    ]
      .filter(Boolean)
      .join('\n\n') || undefined;
  const broadcaster = getBroadcaster(request.ctx);
  const filteredTools = filterAllowedTools(request);
  return {
    instructions,
    remaining,
    broadcaster,
    sdkTools:
      filteredTools && filteredTools.length > 0
        ? convertTools({
            tools: filteredTools,
          })
        : undefined,
    emitIfAllowed(eventType, data) {
      if (!shouldEmit(request.emit, eventType, data)) {
        return;
      }
      emitFrameworkEvent({
        broadcaster,
        agentName,
        eventType,
        data,
      });
    },
  };
}

function filterAllowedTools(request: CallModelRequest): Tool[] | undefined {
  if (!request.tools) {
    return undefined;
  }
  if (!('allowedToolNames' in request) || !request.allowedToolNames) {
    return request.tools;
  }
  const allowedNames = new Set(request.allowedToolNames);
  return request.tools.filter((tool) => allowedNames.has(tool.name));
}

interface AgentHarnessModelCallerOpts {
  agentName: string;
  itemSchemas: ItemSchemaRegistry;
  client?: OpenRouter;
  callModelOverride?: (request: CallModelRequest) => Promise<LLMResponse>;
  streamIdleTimeoutMs: number;
  harness: AgentHarnessContract;
}

export class AgentHarnessModelCaller {
  constructor(private readonly opts: AgentHarnessModelCallerOpts) {}

  private async callOverriddenModel(request: CallModelRequest): Promise<LLMResponse> {
    if (!this.opts.callModelOverride) {
      throw new Error('No callModel override configured.');
    }
    const response = await this.opts.callModelOverride(request);
    const itemSchemas = buildItemSchemaRegistry({
      base: this.opts.itemSchemas,
      layers: request.layers,
      tools: request.tools,
    });
    return {
      ...response,
      items: itemSchemas.parseMany(response.items),
    };
  }

  private requireModelClient(): OpenRouter {
    if (this.opts.client) {
      return this.opts.client;
    }
    throw new NoeticConfigError({
      code: 'NO_LLM_PROVIDER',
      message: 'No LLM provider configured on this harness.',
      hint: 'Pass `llm: { provider: "openrouter", apiKey: "..." }` in constructor options or set OPENROUTER_API_KEY.',
    });
  }

  async callModel(request: CallModelRequest): Promise<LLMResponse> {
    if (this.opts.callModelOverride) {
      return this.callOverriddenModel(request);
    }
    const client = this.requireModelClient();
    const prepared = prepareModelRequest(request, this.opts.agentName);
    const allItems: Item[] = [];
    const totalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    };
    let totalCost = 0;
    const conversationInput = itemsToInput(prepared.remaining);
    const textFormat = request.outputSchema ? buildTextFormat(request.outputSchema) : undefined;
    let round = 0;
    let invalidRecoveryContinuations = 0;
    let toolLimitRecoveryContinuations = 0;
    let useEphemeralContinue = false;

    while (!request.signal?.aborted) {
      const recoveryContinuation = useEphemeralContinue;
      useEphemeralContinue = false;
      if (round > 0 && request.ctx && hasSessionQueue(request.ctx)) {
        this.injectBetweenRoundMessages(
          request.ctx,
          conversationInput,
          round,
          prepared.emitIfAllowed,
        );
      }

      const roundController = new AbortController();
      const roundSignal = request.signal
        ? AbortSignal.any([
            request.signal,
            roundController.signal,
          ])
        : roundController.signal;
      let firstEventSeen = false;
      let idleStalled = false;
      const watchdog = createStreamIdleWatchdog(
        this.opts.streamIdleTimeoutMs,
        roundController,
        () => {
          idleStalled = true;
          prepared.emitIfAllowed('llm_call_stalled', {
            round,
            idleTimeoutMs: this.opts.streamIdleTimeoutMs,
          });
        },
      );
      const modelInput: OpenRouterAgent.Item[] = recoveryContinuation
        ? withEphemeralContinueInput(conversationInput)
        : frameworkCast<OpenRouterAgent.Item[]>(conversationInput);

      prepared.emitIfAllowed('llm_call_started', {
        round,
        messageCount: modelInput.length,
        toolCount: prepared.sdkTools?.length ?? 0,
        recoveryContinuation,
      });

      const callResult = client.callModel(
        {
          model: request.model,
          input: modelInput,
          instructions: prepared.instructions,
          tools: prepared.sdkTools,
          temperature: request.params?.temperature,
          maxOutputTokens: request.params?.maxTokens,
          topP: request.params?.topP,
          ...(textFormat
            ? {
                text: textFormat,
              }
            : {}),
        },
        {
          signal: roundSignal,
        },
      );

      const pipePromise = pipeStreamEventsToBroadcaster({
        stream: callResult.getFullResponsesStream(),
        broadcaster: prepared.broadcaster,
        agentName: this.opts.agentName,
        signal: roundSignal,
        onEvent: () => {
          watchdog.reset();
          if (!firstEventSeen) {
            firstEventSeen = true;
            prepared.emitIfAllowed('llm_call_first_event', {
              round,
            });
          }
        },
      });

      let sdkResponse: Awaited<ReturnType<typeof callResult.getResponse>>;
      try {
        sdkResponse = await awaitWithAbort(callResult.getResponse(), roundSignal);
        watchdog.stop();
        await awaitWithAbort(pipePromise, roundSignal);
      } catch (err: unknown) {
        if (idleStalled) {
          throw roundSignal.reason instanceof Error
            ? roundSignal.reason
            : new Error(`llm stream idle timeout after ${this.opts.streamIdleTimeoutMs}ms`);
        }
        if (request.signal?.aborted) {
          break;
        }
        throw err;
      } finally {
        watchdog.stop();
      }
      if (request.signal?.aborted) {
        break;
      }
      const recovery = this.handleModelRecovery({
        sdkResponse,
        round,
        invalidRecoveryContinuations,
        emitIfAllowed: prepared.emitIfAllowed,
      });
      if (recovery.kind === 'continue') {
        invalidRecoveryContinuations = recovery.invalidRecoveryContinuations;
        useEphemeralContinue = true;
        continue;
      }

      const roundItemSchemas = buildItemSchemaRegistry({
        base: this.opts.itemSchemas,
        layers: request.layers,
        tools: request.tools,
      });
      const roundItems = roundItemSchemas.parseMany(extractOutputItems(sdkResponse));
      const outputRecovery = this.handleEmptyOutputRecovery({
        sdkResponse,
        roundItems,
        round,
        invalidRecoveryContinuations,
        emitIfAllowed: prepared.emitIfAllowed,
      });
      if (outputRecovery.kind === 'continue') {
        invalidRecoveryContinuations = outputRecovery.invalidRecoveryContinuations;
        useEphemeralContinue = true;
        continue;
      }
      invalidRecoveryContinuations = 0;
      prepared.emitIfAllowed('llm_call_completed', {
        round,
        itemCount: sdkResponse.output?.length ?? 0,
      });
      const roundUsage = extractUsage(sdkResponse.usage);
      totalUsage.inputTokens += roundUsage.inputTokens;
      totalUsage.outputTokens += roundUsage.outputTokens;
      totalUsage.cachedTokens += roundUsage.cachedTokens ?? 0;
      totalCost += sdkResponse.usage?.cost ?? 0;
      allItems.push(...roundItems);

      const functionCalls = roundItems.filter(isFunctionCall);
      if (functionCalls.length === 0 || !request.tools) {
        break;
      }
      await this.executeToolRound({
        functionCalls,
        request,
        allItems,
        conversationInput,
        round,
        emitIfAllowed: prepared.emitIfAllowed,
      });

      round += 1;
      const limitRecovery = this.handleToolRoundLimit({
        round,
        toolLimitRecoveryContinuations,
        emitIfAllowed: prepared.emitIfAllowed,
      });
      if (limitRecovery.kind === 'continue') {
        toolLimitRecoveryContinuations = limitRecovery.toolLimitRecoveryContinuations;
        useEphemeralContinue = true;
      }
    }

    return {
      items: allItems,
      usage: totalUsage,
      cost: totalCost > 0 ? totalCost : undefined,
    };
  }

  private injectBetweenRoundMessages(
    ctx: Context & Required<SessionCtxExtension>,
    conversationInput: ReturnType<typeof itemsToInput>,
    round: number,
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void,
  ): void {
    const injected = this.drainBetweenRoundsMessages(ctx._sessionQueue);
    if (injected.length === 0) {
      return;
    }
    for (const msg of injected) {
      const text = itemToText(msg);
      const userItem: InputMessageItem = {
        id: `user-${crypto.randomUUID()}`,
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text,
          },
        ],
      };
      conversationInput.push({
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text,
          },
        ],
      });
      ctx.itemLog.append(userItem);
    }
    emitIfAllowed('inbox_injected', {
      round,
      count: injected.length,
      messageIds: injected.map((i) => i.id),
    });
  }

  private handleModelRecovery(params: {
    sdkResponse: unknown;
    round: number;
    invalidRecoveryContinuations: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }):
    | {
        kind: 'continue';
        invalidRecoveryContinuations: number;
      }
    | {
        kind: 'ok';
      } {
    const terminalError = providerTerminalError(params.sdkResponse);
    if (!terminalError) {
      return {
        kind: 'ok',
      };
    }
    params.emitIfAllowed('llm_call_failed', {
      round: params.round,
      status: terminalError.status,
      error: terminalError.message,
      recoverable: params.invalidRecoveryContinuations < MAX_RECOVERY_CONTINUATIONS,
    });
    if (params.invalidRecoveryContinuations >= MAX_RECOVERY_CONTINUATIONS) {
      throw new Error(terminalError.message);
    }
    const next = params.invalidRecoveryContinuations + 1;
    params.emitIfAllowed('llm_call_recovery_continue', {
      round: params.round,
      status: terminalError.status,
      attempt: next,
      maxAttempts: MAX_RECOVERY_CONTINUATIONS,
    });
    return {
      kind: 'continue',
      invalidRecoveryContinuations: next,
    };
  }

  private handleEmptyOutputRecovery(params: {
    sdkResponse: unknown;
    roundItems: ReadonlyArray<Item>;
    round: number;
    invalidRecoveryContinuations: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }):
    | {
        kind: 'continue';
        invalidRecoveryContinuations: number;
      }
    | {
        kind: 'ok';
      } {
    if (hasUsableResponseOutput(params.sdkResponse, params.roundItems)) {
      return {
        kind: 'ok',
      };
    }
    const message = 'LLM response completed with no output items';
    params.emitIfAllowed('llm_call_failed', {
      round: params.round,
      status: 'completed',
      error: message,
      recoverable: params.invalidRecoveryContinuations < MAX_RECOVERY_CONTINUATIONS,
    });
    if (params.invalidRecoveryContinuations >= MAX_RECOVERY_CONTINUATIONS) {
      throw new Error(message);
    }
    const next = params.invalidRecoveryContinuations + 1;
    params.emitIfAllowed('llm_call_recovery_continue', {
      round: params.round,
      status: 'completed',
      attempt: next,
      maxAttempts: MAX_RECOVERY_CONTINUATIONS,
    });
    return {
      kind: 'continue',
      invalidRecoveryContinuations: next,
    };
  }

  private async executeToolRound(params: {
    functionCalls: Extract<
      Item,
      {
        type: 'function_call';
      }
    >[];
    request: CallModelRequest;
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    round: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }): Promise<void> {
    const { functionCalls, request, allItems, conversationInput } = params;
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
    for (const fc of functionCalls) {
      if (request.signal?.aborted) {
        break;
      }
      await this.executeFunctionCall({
        fc,
        request,
        allItems,
        conversationInput,
        emitIfAllowed: params.emitIfAllowed,
      });
    }
    params.emitIfAllowed('tool_round_completed', {
      round: params.round,
      toolCount: functionCalls.length,
    });
  }

  private async executeFunctionCall(params: {
    fc: Extract<
      Item,
      {
        type: 'function_call';
      }
    >;
    request: CallModelRequest;
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }): Promise<void> {
    const { fc, request, allItems, conversationInput } = params;
    params.emitIfAllowed('tool_call_started', {
      name: fc.name,
      callId: fc.callId,
    });
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(fc.arguments);
    } catch {
      this.recordMalformedToolCall({
        fc,
        request,
        allItems,
        conversationInput,
        emitIfAllowed: params.emitIfAllowed,
      });
      return;
    }
    if (!request.tools) {
      throw new Error(
        `executeFunctionCall invoked without tools on CallModelRequest (tool name: ${fc.name}).`,
      );
    }
    const toolForCall = request.tools.find(
      (tool) => tool.name === fc.name || sanitizeToolNameForWire(tool.name) === fc.name,
    );
    const toolResult = await executeToolCall({
      toolName: fc.name,
      args: parsedArgs,
      tools: request.tools,
      context: request.ctx,
      harness: this.opts.harness,
      layers: request.layers,
    });
    // Owner-scoped result validation: a tool's `toolResults` schemas apply
    // only to that tool's own result items. Harness-level `opts.itemSchemas`
    // stay global by design; sibling tools' schemas never reject this item.
    const outputItem = createToolResultItem({
      output: toolResult.output,
      callId: fc.callId,
      roundItemSchemas: this.opts.itemSchemas.extend(toolForCall?.itemSchemas),
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
    params.emitIfAllowed('tool_call_completed', {
      name: fc.name,
      callId: fc.callId,
      error: false,
    });
  }

  private recordMalformedToolCall(params: {
    fc: Extract<
      Item,
      {
        type: 'function_call';
      }
    >;
    request: CallModelRequest;
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }): void {
    const { fc, request, allItems, conversationInput } = params;
    const errorOutput = `Error: malformed JSON in tool arguments: ${fc.arguments}`;
    const toolForCall = request.tools?.find((tool) => tool.name === fc.name);
    // Owner-scoped result validation (see executeFunctionCall).
    const outputItem = createToolResultItem({
      output: errorOutput,
      callId: fc.callId,
      roundItemSchemas: this.opts.itemSchemas.extend(toolForCall?.itemSchemas),
      tool: toolForCall,
      callItem: fc,
      error: true,
    });
    allItems.push(outputItem);
    conversationInput.push({
      type: 'function_call_output',
      callId: fc.callId,
      output: errorOutput,
    });
    params.emitIfAllowed('tool_call_completed', {
      name: fc.name,
      callId: fc.callId,
      error: true,
    });
  }

  private handleToolRoundLimit(params: {
    round: number;
    toolLimitRecoveryContinuations: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }):
    | {
        kind: 'continue';
        toolLimitRecoveryContinuations: number;
      }
    | {
        kind: 'ok';
      } {
    if (params.round < MAX_TOOL_ROUNDS) {
      return {
        kind: 'ok',
      };
    }
    params.emitIfAllowed('tool_round_limit_exceeded', {
      maxToolRounds: MAX_TOOL_ROUNDS,
      attempt: params.toolLimitRecoveryContinuations + 1,
      maxAttempts: MAX_RECOVERY_CONTINUATIONS,
    });
    if (params.toolLimitRecoveryContinuations >= MAX_RECOVERY_CONTINUATIONS) {
      throw new Error(`LLM exceeded maximum tool rounds (${MAX_TOOL_ROUNDS})`);
    }
    return {
      kind: 'continue',
      toolLimitRecoveryContinuations: params.toolLimitRecoveryContinuations + 1,
    };
  }

  /** @internal Drain only messages tagged `between-rounds` from the queue. */
  private drainBetweenRoundsMessages(queue: MessageQueue): QueuedMessage[] {
    const pending = queue.peekAll();
    const toInject: QueuedMessage[] = [];
    const keep: QueuedMessage[] = [];
    for (const msg of pending) {
      if (msg.deliveryMode === 'between-rounds') {
        toInject.push(msg);
        continue;
      }
      keep.push(msg);
    }
    if (toInject.length === 0) {
      return [];
    }
    queue.drainAll();
    for (const msg of keep) {
      queue.enqueue(msg);
    }
    return toInject;
  }
}

function itemToText(msg: QueuedMessage): string {
  if (typeof msg.input === 'string') {
    return msg.input;
  }
  const items = Array.isArray(msg.input)
    ? msg.input
    : [
        msg.input,
      ];
  const texts: string[] = [];
  for (const item of items) {
    if (item.type !== 'message') {
      continue;
    }
    for (const part of item.content) {
      if (part.type === 'input_text' || part.type === 'output_text') {
        texts.push(part.text);
      }
    }
  }
  return texts.join('\n');
}
