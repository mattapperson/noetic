import type { Item } from '@noetic-tools/types';
import { emitFrameworkEvent } from '../runtime/broadcaster-utils';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import type { Dispatch } from './spend';

/**
 * Reading a model response stream: piping SDK events to the broadcaster,
 * spotting the generation id and terminal errors, and racing awaits against abort.
 */

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
