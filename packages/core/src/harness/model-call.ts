import type {
  AgentHarnessContract,
  CallModelRequest,
  Context,
  Item,
  ItemSchemaRegistry,
  LLMResponse,
  TraceExporter,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, SpendKind, SteerPoint } from '@noetic-tools/types';
import type * as OpenRouterAgent from '@openrouter/agent';
import type { OpenRouter } from '@openrouter/agent';
import {
  extractOutputItems,
  extractUsage,
  itemsToInput,
  toolsOnWire,
} from '../adapters/openrouter';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import { drainsOf } from '../runtime/drain';
import { markSpent } from '../util/spent';
import { CallSpanCollector } from './call-span-collector';
import type { Bill } from './call-spend';
import { CallSpend, noBill } from './call-spend';
import { buildTextFormat, prepareModelRequest } from './model-request';
import type { RoundRecord } from './model-rounds';
import { RoundLedger } from './model-rounds';
import { buildItemSchemaRegistry } from './model-schema.js';
import {
  awaitWithAbort,
  hasUsableResponseOutput,
  noteStreamGeneration,
  pipeStreamEventsToBroadcaster,
  providerTerminalError,
} from './model-stream';
import type { ToolRoundScope } from './model-tool-round';
import { hasFunctionCalls, replayOutput, runToolRound } from './model-tool-round';
import type { Spend } from './spend';
import type { SteerInbox } from './steer-inbox';
import { openSteerInbox } from './steer-inbox';

const MAX_TOOL_ROUNDS = 32;
const MAX_RECOVERY_CONTINUATIONS = 3;
const EPHEMERAL_CONTINUE_INPUT = 'continue';

function itemIds(items: ReadonlyArray<Item>): string[] {
  return items.flatMap((item) =>
    'id' in item && typeof item.id === 'string'
      ? [
          item.id,
        ]
      : [],
  );
}

function hasItem(items: ReadonlyArray<Item>, id: string): boolean {
  return items.some((item) => 'id' in item && item.id === id);
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

interface StreamIdleWatchdog {
  /** Bump the deadline because a stream event just arrived. */
  reset: () => void;
  /** Clear the pending timer. Safe to call multiple times. */
  stop: () => void;
}

/** @internal The error for a model call on a harness with no LLM credentials. */
export function noLlmProviderError(): NoeticConfigError {
  return new NoeticConfigError({
    code: 'NO_LLM_PROVIDER',
    message: 'No LLM provider configured on this harness.',
    hint: 'Pass `callModelDefaults: { apiKey: "..." }` (defaults to the Noetic platform) or set NOETIC_API_KEY. For direct OpenRouter, use `callModelDefaults: { provider: "openrouter", apiKey: "..." }` or set OPENROUTER_API_KEY.',
  });
}

/** @internal Create a watchdog that aborts `controller` when no
 *  {@link StreamIdleWatchdog.reset reset} is called within `timeoutMs`. When
 *  `timeoutMs <= 0`, returns an inert no-op so callers can always call `.reset()`
 *  / `.stop()` without branching. Starts armed: the caller is responsible for
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
      const reason = new Error(`model stream idle timeout after ${timeoutMs}ms`);
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

interface AgentHarnessModelCallerOpts {
  agentName: string;
  itemSchemas: ItemSchemaRegistry;
  client?: OpenRouter;
  callModelOverride?: (request: CallModelRequest) => Promise<LLMResponse>;
  streamIdleTimeoutMs: number;
  harness: AgentHarnessContract;
  traceExporter: TraceExporter;
  /** Records each paid round before it is sent. Absent without durable storage. */
  spend?: Spend;
}

export class AgentHarnessModelCaller {
  constructor(private readonly opts: AgentHarnessModelCallerOpts) {}

  private newSpanCollector(request: CallModelRequest): CallSpanCollector {
    return new CallSpanCollector(
      this.opts.harness,
      this.opts.traceExporter,
      request.parentSpan ?? request.ctx?.span ?? null,
      request.nodeId,
      request.spanAttributes,
    );
  }

  /**
   * Broadcast a framework-authored item so `getItemStream` carries it — tool
   * results and injected messages never appear in the SDK stream. Emitted
   * unconditionally: item streaming, like the SDK item events, is not subject
   * to `step.emit` filtering.
   */
  private emitItemAppended(ctx: Context | undefined, item: Item): void {
    emitFrameworkEvent({
      broadcaster: getBroadcaster(ctx),
      agentName: this.opts.agentName,
      eventType: 'item_appended',
      data: {
        item,
      },
    });
  }

  /** What the tool-round functions need from this caller. */
  private toolRoundScope(): ToolRoundScope {
    return {
      harness: this.opts.harness,
      itemSchemas: this.opts.itemSchemas,
      emitItemAppended: (ctx, item) => this.emitItemAppended(ctx, item),
    };
  }

  private async callOverriddenModel(request: CallModelRequest): Promise<LLMResponse> {
    if (!this.opts.callModelOverride) {
      throw new Error('No callModel override configured.');
    }
    const spans = this.newSpanCollector(request);
    const modelSpan = spans.startModelSpan(request.model);
    const finished = drainsOf(request.ctx)?.track(request.ctx, {
      kind: 'model_round',
      model: request.model,
      round: 0,
    });
    let response: LLMResponse | undefined;
    try {
      response = await this.opts.callModelOverride(request);
      const itemSchemas = buildItemSchemaRegistry({
        base: this.opts.itemSchemas,
        layers: request.layers,
        tools: request.tools,
      });
      spans.finishModelSpan(modelSpan, response.usage, response.cost);
      return {
        ...response,
        items: itemSchemas.parseMany(response.items),
      };
    } finally {
      finished?.(
        response && {
          cost: response.cost ?? 0,
          usage: response.usage,
        },
      );
      await spans.flush();
    }
  }

  private requireModelClient(): OpenRouter {
    if (this.opts.client) {
      return this.opts.client;
    }
    throw noLlmProviderError();
  }

  async callModel(request: CallModelRequest): Promise<LLMResponse> {
    if (this.opts.callModelOverride) {
      return this.callOverriddenModel(request);
    }
    const client = this.requireModelClient();
    const spans = this.newSpanCollector(request);
    const spend = new CallSpend();
    const roundLedger = RoundLedger.open(request.ctx);
    try {
      return await this.runModelLoop({
        request,
        client,
        spans,
        spend,
        roundLedger,
      });
    } catch (error: unknown) {
      throw markSpent(error, spend.charge(), () => roundLedger?.charged());
    } finally {
      await spans.flush();
    }
  }

  private async runModelLoop({
    request,
    client,
    spans,
    spend,
    roundLedger,
  }: {
    request: CallModelRequest;
    client: OpenRouter;
    spans: CallSpanCollector;
    spend: CallSpend;
    roundLedger: RoundLedger | undefined;
  }): Promise<LLMResponse> {
    const prepared = prepareModelRequest(request, this.opts.agentName);
    const allItems: Item[] = [];
    let servedTier: string | undefined;
    const conversationInput = itemsToInput(prepared.remaining);
    const textFormat = request.outputSchema
      ? buildTextFormat(request.outputSchema, request.outputJsonSchema)
      : undefined;
    let round = 0;
    let invalidRecoveryContinuations = 0;
    let toolLimitRecoveryContinuations = 0;
    let useEphemeralContinue = false;
    const drains = drainsOf(request.ctx);
    const replaySchemas = buildItemSchemaRegistry({
      base: this.opts.itemSchemas,
      layers: request.layers,
      tools: request.tools,
    });
    // Where the loop's lists stood when the current round began, for its record.
    let marks = {
      round: -1,
      log: 0,
      input: 0,
      items: 0,
    };
    const markRound = (): void => {
      marks = {
        round,
        log: roundLedger?.mark() ?? 0,
        input: conversationInput.length,
        items: allItems.length,
      };
    };
    // The current round's checkpoint writes, in order. Its own record waits for
    // them, so a late checkpoint never replaces it.
    let checkpoints: Promise<void> = Promise.resolve();
    const writeRound = async (record: RoundRecord): Promise<void> => {
      if (!roundLedger || request.signal?.aborted) {
        return;
      }
      if (!(await roundLedger.record(round, marks.log, record))) {
        return;
      }
      prepared.emitIfAllowed('model_round_recorded', {
        round,
        itemIds: itemIds(record.items),
        done: !record.cut,
      });
    };
    // A rejected round is asked again on the conversation it was asked on, or fails
    // the call, so a resume must not go on from the items it streamed. The same goes
    // for the round that ends the loop.
    const dropCheckpoints = async (): Promise<void> => {
      await checkpoints;
      await roundLedger?.drop(round);
    };
    const rejectRound = async <
      T extends {
        kind: 'continue' | 'ok';
      },
    >(
      check: () => T,
    ): Promise<T> => {
      let result: T;
      try {
        result = check();
      } catch (error: unknown) {
        await dropCheckpoints();
        throw error;
      }
      if (result.kind === 'continue') {
        await dropCheckpoints();
      }
      return result;
    };
    // Record a round the loop goes on from, so a resumed loop can replay it.
    const recordRound = async (bill: Bill): Promise<void> => {
      await checkpoints;
      await writeRound({
        items: allItems.slice(marks.items),
        input: conversationInput.slice(marks.input),
        ...bill,
      });
    };
    // Record the output items a round has finished while it still streams, so a
    // resume goes on from them rather than making them again. The input holds only
    // what the round began with: the tool round adds each function call with its
    // output, as it does for a round that finishes.
    const checkpoint = (finished: Item[]): void => {
      if (!roundLedger) {
        return;
      }
      const record: RoundRecord = {
        items: [
          ...allItems.slice(marks.items),
          ...finished,
        ],
        input: conversationInput.slice(marks.input),
        ...noBill,
        cut: true,
      };
      checkpoints = checkpoints.then(() => writeRound(record));
    };
    let stoppedForRecall = false;
    const steers = openSteerInbox({
      ctx: request.ctx,
      layers: request.layers ?? [],
      harness: this.opts.harness,
      emit: prepared.emitIfAllowed,
      inConversation: (itemId) =>
        hasItem(allItems, itemId) || hasItem(request.ctx?.itemLog.items ?? [], itemId),
    });

    while (!request.signal?.aborted) {
      const replayed = roundLedger?.take(round, replaySchemas);
      if (replayed) {
        markRound();
        allItems.push(...replayed.items);
        conversationInput.push(...frameworkCast<typeof conversationInput>(replayed.input));
        for (const item of replayed.appended) {
          request.ctx?.itemLog.append(item);
        }
        // A cut round never reported usage, so it has no bill to count.
        if (!replayed.charged && !replayed.cut) {
          spend.replay(replayed);
        }
        prepared.emitIfAllowed('model_round_replayed', {
          round,
        });
        if (replayed.cut && !hasFunctionCalls(replayed.items)) {
          // The stream was cut after the answer finished: it ends the loop.
          break;
        }
        if (replayed.cut) {
          // Go on from the function calls the stream finished: run them, then ask
          // the model again with their results in the conversation.
          await runToolRound(this.toolRoundScope(), {
            roundItems: replayed.items,
            request,
            prepared,
            allItems,
            conversationInput,
            round,
            spans,
            modelSpan: null,
            steers,
          });
          await recordRound(spend.keep());
        }
        round += 1;
        const replayLimit = this.handleToolRoundLimit({
          round,
          toolLimitRecoveryContinuations,
          emitIfAllowed: prepared.emitIfAllowed,
        });
        if (replayLimit.kind === 'continue') {
          toolLimitRecoveryContinuations = replayLimit.toolLimitRecoveryContinuations;
          useEphemeralContinue = true;
        }
        continue;
      }
      if (marks.round !== round) {
        markRound();
      }
      // A graceful stop starts no new round: wait here until it cancels the call.
      await drains?.hold(request.ctx);
      if (request.signal?.aborted) {
        break;
      }
      const recoveryContinuation = useEphemeralContinue;
      useEphemeralContinue = false;
      if (steers) {
        const recall = await this.applySteers({
          steers,
          ctx: request.ctx,
          conversationInput,
          allItems,
          round,
          emitIfAllowed: prepared.emitIfAllowed,
        });
        if (recall) {
          stoppedForRecall = true;
          break;
        }
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
          prepared.emitIfAllowed('model_call_stalled', {
            round,
            idleTimeoutMs: this.opts.streamIdleTimeoutMs,
          });
        },
      );
      const modelInput: OpenRouterAgent.Item[] = recoveryContinuation
        ? withEphemeralContinueInput(conversationInput)
        : frameworkCast<OpenRouterAgent.Item[]>(conversationInput);

      prepared.emitIfAllowed('model_call_started', {
        round,
        messageCount: modelInput.length,
        toolCount: prepared.sdkTools?.length ?? 0,
        recoveryContinuation,
      });

      const modelSpan = spans.startModelSpan(request.model);
      const dispatch = await this.opts.spend?.open({
        ctx: request.ctx ?? request._billTo,
        kind: SpendKind.Model,
        model: request.model,
        body: {
          model: request.model,
          instructions: prepared.instructions,
          input: modelInput,
          tools: prepared.sdkTools && toolsOnWire(prepared.sdkTools),
          text: textFormat,
        },
        maxOutputTokens: request.params?.maxTokens,
        round,
      });
      if (request.signal?.aborted) {
        // Aborted while the record was written: the call was never sent.
        await dispatch?.settle();
        modelSpan.end();
        break;
      }

      const roundFinished = drains?.track(
        request.ctx,
        {
          kind: 'model_round',
          model: request.model,
          round,
        },
        dispatch?.record,
      );
      const callResult = client.callModel(
        {
          model: request.model,
          input: modelInput,
          instructions: prepared.instructions,
          tools: prepared.sdkTools,
          toolChoice: round === 0 ? prepared.toolChoice.first : prepared.toolChoice.rest,
          temperature: request.params?.temperature,
          maxOutputTokens: request.params?.maxTokens,
          topP: request.params?.topP,
          // The agent's bundled SDK types an older tier list (no `fast` or
          // `ultrafast`); the field is an open enum, so newer tiers pass through.
          serviceTier: frameworkCast<OpenRouterAgent.CallModelInput['serviceTier']>(
            request.params?.serviceTier,
          ),
          ...(textFormat
            ? {
                text: textFormat,
              }
            : {}),
        },
        {
          signal: roundSignal,
          ...(dispatch
            ? {
                headers: dispatch.headers,
              }
            : {}),
        },
      );

      // Output items the stream has finished, kept so a steer can stop the
      // round early without losing them.
      const finishedItems: unknown[] = [];
      // Parsed for the round ledger; none once the stream has failed, since a call
      // that has thrown must write nothing more.
      const parsedItems: Item[] = [];
      let streaming = true;
      let steered = false;
      const pipePromise = pipeStreamEventsToBroadcaster({
        stream: callResult.getFullResponsesStream(),
        broadcaster: prepared.broadcaster,
        agentName: this.opts.agentName,
        signal: roundSignal,
        onEvent: (event) => {
          watchdog.reset();
          noteStreamGeneration(dispatch, event);
          if (!firstEventSeen) {
            firstEventSeen = true;
            prepared.emitIfAllowed('model_call_first_event', {
              round,
            });
          }
        },
        onItemDone: async (item) => {
          finishedItems.push(item);
          if (streaming && roundLedger) {
            try {
              parsedItems.push(
                ...replaySchemas.parseMany(
                  frameworkCast<Item[]>([
                    item,
                  ]),
                ),
              );
              checkpoint(parsedItems);
            } catch {
              // The round fails on this item when it ends; nothing after it can be
              // gone on from.
              streaming = false;
            }
          }
          if (!steers?.hasQueued() || !(await steers.offer(SteerPoint.ItemDone))) {
            return;
          }
          steered = true;
          roundController.abort(new Error('steered'));
        },
      });

      // A dropped connection rejects the response and the event pipe together; the
      // response's rejection is the one that propagates. Unobserved, the pipe's would
      // surface as an unhandled rejection and take the host process down with it.
      pipePromise.catch(() => {});
      let sdkResponse: Awaited<ReturnType<typeof callResult.getResponse>> | undefined;
      try {
        sdkResponse = await awaitWithAbort(callResult.getResponse(), roundSignal);
        watchdog.stop();
        // Counted before its record goes and before the recovery checks: a round
        // rejected below and asked again was billed all the same. Once counted, the
        // call charges its context with this bill however it ends, so a drain that
        // reports from here on lists the round finished with it.
        const roundUsage = extractUsage(sdkResponse.usage);
        const roundCost = sdkResponse.usage?.cost ?? 0;
        spend.count(roundUsage, roundCost);
        roundFinished?.({
          cost: roundCost,
          usage: roundUsage,
        });
        spans.finishModelSpan(modelSpan, roundUsage, roundCost > 0 ? roundCost : undefined);
        await dispatch?.settle();
        await awaitWithAbort(pipePromise, roundSignal);
      } catch (err: unknown) {
        streaming = false;
        await checkpoints;
        if (dispatch?.wasRefused(err)) {
          await dispatch.settle();
        }
        if (idleStalled) {
          throw roundSignal.reason instanceof Error
            ? roundSignal.reason
            : new Error(`model stream idle timeout after ${this.opts.streamIdleTimeoutMs}ms`);
        }
        if (!steered && !request.signal?.aborted) {
          throw err;
        }
      } finally {
        watchdog.stop();
        dispatch?.end();
        if (!sdkResponse) {
          roundFinished?.();
        }
      }
      if (request.signal?.aborted) {
        break;
      }
      if (!sdkResponse) {
        // A steer stopped the stream before the response finished. The provider
        // never reports usage for a cut response, so this round adds none.
        modelSpan.end();
        const bill = spend.keep();
        const roundItems = this.parseRoundItems(request, frameworkCast<Item[]>(finishedItems));
        prepared.emitIfAllowed('model_call_steered', {
          round,
          itemCount: roundItems.length,
        });
        allItems.push(...roundItems);
        replayOutput(conversationInput, roundItems);
        await runToolRound(this.toolRoundScope(), {
          roundItems,
          request,
          prepared,
          allItems,
          conversationInput,
          round,
          spans,
          modelSpan,
          steers,
        });
        await recordRound(bill);
        round += 1;
        const cutLimitRecovery = this.handleToolRoundLimit({
          round,
          toolLimitRecoveryContinuations,
          emitIfAllowed: prepared.emitIfAllowed,
        });
        if (cutLimitRecovery.kind === 'continue') {
          toolLimitRecoveryContinuations = cutLimitRecovery.toolLimitRecoveryContinuations;
          useEphemeralContinue = true;
        }
        continue;
      }
      const recovery = await rejectRound(() =>
        this.handleModelRecovery({
          sdkResponse,
          round,
          invalidRecoveryContinuations,
          emitIfAllowed: prepared.emitIfAllowed,
        }),
      );
      if (recovery.kind === 'continue') {
        invalidRecoveryContinuations = recovery.invalidRecoveryContinuations;
        useEphemeralContinue = true;
        continue;
      }

      const roundItems = this.parseRoundItems(request, extractOutputItems(sdkResponse));
      const outputRecovery = await rejectRound(() =>
        this.handleEmptyOutputRecovery({
          sdkResponse,
          roundItems,
          round,
          invalidRecoveryContinuations,
          emitIfAllowed: prepared.emitIfAllowed,
        }),
      );
      if (outputRecovery.kind === 'continue') {
        invalidRecoveryContinuations = outputRecovery.invalidRecoveryContinuations;
        useEphemeralContinue = true;
        continue;
      }
      invalidRecoveryContinuations = 0;
      const bill = spend.keep();
      prepared.emitIfAllowed('model_call_completed', {
        round,
        itemCount: sdkResponse.output?.length ?? 0,
      });
      servedTier = sdkResponse.serviceTier ?? undefined;
      allItems.push(...roundItems);

      const ranTools = await runToolRound(this.toolRoundScope(), {
        roundItems,
        request,
        prepared,
        allItems,
        conversationInput,
        round,
        spans,
        modelSpan,
        steers,
      });
      // A steer staged while the final answer streamed gets its own round, so
      // the model answers it inside this call rather than in the next turn.
      if (!ranTools && !steers?.hasStaged()) {
        // The step's own record covers the round that ends the loop. A cut record
        // left behind would hand a retry this answer after the step rejected it.
        await dropCheckpoints();
        break;
      }
      if (!ranTools) {
        replayOutput(conversationInput, roundItems);
      }
      await recordRound(bill);

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
      ...spend.totals(),
      ...(stoppedForRecall
        ? {
            recall: true,
          }
        : {}),
      ...(servedTier
        ? {
            serviceTier: servedTier,
          }
        : {}),
    };
  }

  /**
   * Offer queued steers before a model call and add the applied ones to the
   * conversation. They join `allItems` rather than the log so the log keeps
   * them in the order the model saw them. Returns whether a layer asked for
   * recall to run again before the call goes on.
   */
  private async applySteers(params: {
    steers: SteerInbox;
    ctx: Context | undefined;
    conversationInput: ReturnType<typeof itemsToInput>;
    allItems: Item[];
    round: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }): Promise<boolean> {
    const { steers, ctx, conversationInput, allItems } = params;
    await steers.offer(SteerPoint.BeforeRound);
    const { messageIds, items, recall } = steers.takeStaged();
    if (messageIds.length === 0) {
      return false;
    }
    conversationInput.push(...itemsToInput(items));
    for (const item of items) {
      allItems.push(item);
      this.emitItemAppended(ctx, item);
    }
    params.emitIfAllowed('inbox_injected', {
      round: params.round,
      count: messageIds.length,
      messageIds,
    });
    return recall;
  }

  private parseRoundItems(request: CallModelRequest, items: Item[]): Item[] {
    const roundItemSchemas = buildItemSchemaRegistry({
      base: this.opts.itemSchemas,
      layers: request.layers,
      tools: request.tools,
    });
    return roundItemSchemas.parseMany(items);
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
    params.emitIfAllowed('model_call_failed', {
      round: params.round,
      status: terminalError.status,
      error: terminalError.message,
      recoverable: params.invalidRecoveryContinuations < MAX_RECOVERY_CONTINUATIONS,
    });
    if (params.invalidRecoveryContinuations >= MAX_RECOVERY_CONTINUATIONS) {
      throw new Error(terminalError.message);
    }
    const next = params.invalidRecoveryContinuations + 1;
    params.emitIfAllowed('model_call_recovery_continue', {
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
    params.emitIfAllowed('model_call_failed', {
      round: params.round,
      status: 'completed',
      error: message,
      recoverable: params.invalidRecoveryContinuations < MAX_RECOVERY_CONTINUATIONS,
    });
    if (params.invalidRecoveryContinuations >= MAX_RECOVERY_CONTINUATIONS) {
      throw new Error(message);
    }
    const next = params.invalidRecoveryContinuations + 1;
    params.emitIfAllowed('model_call_recovery_continue', {
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
}
