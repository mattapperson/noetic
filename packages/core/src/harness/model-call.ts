import type {
  AgentHarnessContract,
  CallModelRequest,
  Context,
  Item,
  ItemSchemaRegistry,
  LLMResponse,
  TraceExporter,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, SteerPoint } from '@noetic-tools/types';
import type * as OpenRouterAgent from '@openrouter/agent';
import type { OpenRouter } from '@openrouter/agent';
import { extractOutputItems, itemsToInput } from '../adapters/openrouter';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import { drainsOf } from '../runtime/drain';
import { markSpent } from '../util/spent';
import { CallSpanCollector } from './call-span-collector';
import { CallSpend } from './call-spend';
import { buildTextFormat, prepareModelRequest } from './model-request';
import { openRoundJournal, RoundLedger } from './model-rounds';
import { buildItemSchemaRegistry } from './model-schema.js';
import { dispatchRound, hasUsableResponseOutput, providerTerminalError } from './model-stream';
import type { ToolRoundScope } from './model-tool-round';
import { hasFunctionCalls, replayOutput, runToolRound } from './model-tool-round';
import type { Spend } from './spend';
import type { SteerInbox } from './steer-inbox';
import { openSteerInbox } from './steer-inbox';

const MAX_RECOVERY_CONTINUATIONS = 3;
const EPHEMERAL_CONTINUE_INPUT = 'continue';

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

/** @internal The error for a model call on a harness with no LLM credentials. */
export function noLlmProviderError(): NoeticConfigError {
  return new NoeticConfigError({
    code: 'NO_LLM_PROVIDER',
    message: 'No LLM provider configured on this harness.',
    hint: 'Pass `callModelDefaults: { apiKey: "..." }` (defaults to the Noetic platform) or set NOETIC_API_KEY. For direct OpenRouter, use `callModelDefaults: { provider: "openrouter", apiKey: "..." }` or set OPENROUTER_API_KEY.',
  });
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
    let useEphemeralContinue = false;
    const drains = drainsOf(request.ctx);
    const replaySchemas = buildItemSchemaRegistry({
      base: this.opts.itemSchemas,
      layers: request.layers,
      tools: request.tools,
    });
    const journal = openRoundJournal({
      roundLedger,
      allItems,
      conversationInput,
      signal: request.signal,
      emit: prepared.emitIfAllowed,
    });
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
        journal.mark(round);
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
            calls: roundLedger?.calls(round),
          });
          await journal.record(spend.keep());
        }
        round += 1;
        continue;
      }
      if (!journal.marked(round)) {
        journal.mark(round);
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

      const modelInput = recoveryContinuation
        ? withEphemeralContinueInput(conversationInput)
        : frameworkCast<OpenRouterAgent.Item[]>(conversationInput);
      const { sdkResponse, finishedItems, modelSpan } = await dispatchRound({
        request,
        client,
        round,
        prepared,
        modelInput,
        textFormat,
        recoveryContinuation,
        agentName: this.opts.agentName,
        idleTimeoutMs: this.opts.streamIdleTimeoutMs,
        billing: this.opts.spend,
        drains,
        spans,
        spend,
        steers,
        replaySchemas,
        journal,
      });
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
        // Let the round's cut records land first: each one prunes what is beneath the
        // round's key, which is where the calls about to run are recorded.
        await journal.wait();
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
          calls: roundLedger?.calls(round),
        });
        await journal.record(bill);
        round += 1;
        continue;
      }
      const recovery = await journal.check(() =>
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
      const outputRecovery = await journal.check(() =>
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

      // As above: no cut record may land after a call of this round is recorded.
      await journal.wait();
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
        calls: roundLedger?.calls(round),
      });
      // A steer staged while the final answer streamed gets its own round, so
      // the model answers it inside this call rather than in the next turn.
      if (!ranTools && !steers?.hasStaged()) {
        // The step's own record covers the round that ends the loop. A cut record
        // left behind would hand a retry this answer after the step rejected it.
        await journal.drop();
        break;
      }
      if (!ranTools) {
        replayOutput(conversationInput, roundItems);
      }
      await journal.record(bill);

      round += 1;
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
}
