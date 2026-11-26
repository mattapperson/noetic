/** Send a model round and manage its response stream, usage, and checkpoints. */

import type {
  CallModelRequest,
  ContextInputOrigin,
  Item,
  ItemSchemaRegistry,
  Span,
} from '@noetic-tools/types';
import { frameworkCast, SpendKind, SteerPoint } from '@noetic-tools/types';
import type * as OpenRouterAgent from '@openrouter/agent';
import type { OpenRouter } from '@openrouter/agent';
import { extractUsage, toolsOnWire } from '../adapters/openrouter';
import { emitFrameworkEvent } from '../runtime/broadcaster-utils';
import type { drainsOf } from '../runtime/drain';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import type { CallSpanCollector } from './call-span-collector';
import type { CallSpend } from './call-spend';
import type { buildTextFormat, prepareModelRequest } from './model-request';
import type { openRoundJournal } from './model-rounds';
import type { Dispatch, Spend } from './spend';
import type { SteerInbox } from './steer-inbox';

//#region Dispatch types

interface DispatchRound {
  request: CallModelRequest;
  client: OpenRouter;
  round: number;
  prepared: ReturnType<typeof prepareModelRequest>;
  modelInput: OpenRouterAgent.Item[];
  origins: ReadonlyArray<ContextInputOrigin>;
  textFormat: ReturnType<typeof buildTextFormat> | undefined;
  recoveryContinuation: boolean;
  agentName: string;
  idleTimeoutMs: number;
  billing: Spend | undefined;
  drains: ReturnType<typeof drainsOf>;
  spans: CallSpanCollector;
  spend: CallSpend;
  steers: SteerInbox | undefined;
  replaySchemas: ItemSchemaRegistry;
  journal: Pick<ReturnType<typeof openRoundJournal>, 'enabled' | 'checkpoint' | 'wait'>;
}

interface DispatchedRound {
  sdkResponse?: Awaited<ReturnType<ReturnType<OpenRouter['callModel']>['getResponse']>>;
  finishedItems: unknown[];
  modelSpan: Span;
}

//#endregion

//#region Round dispatch

export async function dispatchRound({
  request,
  client,
  round,
  prepared,
  modelInput,
  origins,
  textFormat,
  recoveryContinuation,
  agentName,
  idleTimeoutMs,
  billing,
  drains,
  spans,
  spend,
  steers,
  replaySchemas,
  journal,
}: DispatchRound): Promise<DispatchedRound> {
  const roundController = new AbortController();
  const roundSignal = request.signal
    ? AbortSignal.any([
        request.signal,
        roundController.signal,
      ])
    : roundController.signal;
  let firstEventSeen = false;
  let idleStalled = false;
  const watchdog = createStreamIdleWatchdog(idleTimeoutMs, roundController, () => {
    idleStalled = true;
    prepared.emitIfAllowed('model_call_stalled', {
      round,
      idleTimeoutMs: idleTimeoutMs,
    });
  });
  prepared.emitIfAllowed('model_call_started', {
    round,
    messageCount: modelInput.length,
    toolCount: prepared.sdkTools?.length ?? 0,
    recoveryContinuation,
  });

  const modelSpan = spans.startModelSpan(request.model);
  const dispatch = await billing?.open({
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
    return {
      finishedItems: [],
      modelSpan,
    };
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
  request._contextObservation?.request({
    target: 'model',
    model: request.model,
    instructions: prepared.instructions,
    input: modelInput,
    origins,
    round,
    sample: request._decisionSample,
    attempt: request._contextAttempt,
  });
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
    agentName: agentName,
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
      if (streaming && journal.enabled) {
        try {
          parsedItems.push(
            ...replaySchemas.parseMany(
              frameworkCast<Item[]>([
                item,
              ]),
            ),
          );
          journal.checkpoint(parsedItems);
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
    await journal.wait();
    if (dispatch?.wasRefused(err)) {
      await dispatch.settle();
    }
    if (idleStalled) {
      throw roundSignal.reason instanceof Error
        ? roundSignal.reason
        : new Error(`model stream idle timeout after ${idleTimeoutMs}ms`);
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

  return {
    sdkResponse,
    finishedItems,
    modelSpan,
  };
}

//#endregion

//#region Idle watchdog

interface StreamIdleWatchdog {
  /** Bump the deadline because a stream event just arrived. */
  reset: () => void;
  /** Clear the pending timer. Safe to call multiple times. */
  stop: () => void;
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

//#endregion

//#region Model stream helpers

export function isStreamRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface ProviderTerminalError {
  status: string;
  message: string;
}

export function providerTerminalError(response: unknown): ProviderTerminalError | null {
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

/**
 * Save the generation id a stream's `response.created` event carries, for a response
 * whose headers did not. OpenRouter's ids start `gen-`; other ids price nothing.
 */
export function noteStreamGeneration(dispatch: Dispatch | undefined, event: unknown): void {
  if (!dispatch || !isStreamRecord(event) || event.type !== 'response.created') {
    return;
  }
  const response = event.response;
  if (!isStreamRecord(response) || typeof response.id !== 'string') {
    return;
  }
  if (response.id.startsWith('gen-')) {
    void dispatch.noteGeneration(response.id);
  }
}

export function hasUsableResponseOutput(response: unknown, items: ReadonlyArray<Item>): boolean {
  if (items.length > 0) {
    return true;
  }
  return (
    isStreamRecord(response) &&
    typeof response.outputText === 'string' &&
    response.outputText.length > 0
  );
}

/** Race a promise against an AbortSignal so callers (e.g. `SessionRunner.abort`)
 *  can break out of a long `await` without waiting for the underlying call to
 *  settle. When the signal fires, the returned promise rejects with
 *  `signal.reason` (an `Error`) or a generic `Error('aborted')` fallback. */
export function awaitWithAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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
  onEvent?: (event: unknown) => void;
  /** Awaited with each finished output item before the next event is read. */
  onItemDone?: (item: unknown) => Promise<void>;
}

export async function pipeStreamEventsToBroadcaster(opts: PipeStreamOpts): Promise<void> {
  const { stream, broadcaster, agentName, signal, onEvent, onItemDone } = opts;
  try {
    for await (const event of stream) {
      if (signal?.aborted) {
        return;
      }
      onEvent?.(event);
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
      if (event.type === 'response.output_item.done' && onItemDone) {
        await onItemDone(event.item);
      }
    }
  } catch (err: unknown) {
    // The stream ends badly when the round is aborted; that is not a pipe fault.
    if (signal?.aborted) {
      return;
    }
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

//#endregion
