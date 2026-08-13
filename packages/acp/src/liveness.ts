/**
 * Keeping a request from outliving the agent that was supposed to answer it.
 *
 * The protocol library's read loop simply breaks when the stream ends:
 *
 * ```ts
 * const { value: message, done } = await reader.read();
 * if (done) { break; }
 * ```
 *
 * Nothing rejects the responses still pending at that moment, so if the agent's
 * stdout closes — a missing binary, a crash on startup, an OOM mid-turn — every
 * in-flight `initialize` or `prompt` waits forever. A step built on it hangs
 * with no error and no timeout, and aborting the context does not help because
 * the promise it would race against never settles either.
 *
 * This watches the readable for end-of-stream and turns it into a rejection,
 * and does the same for an abort signal, so a dead agent surfaces as an error
 * instead of silence.
 */

import type { AcpTransport } from '@noetic-tools/types';
import { AcpConnectError } from '@noetic-tools/types';

/** @public A transport whose end-of-stream is observable. */
export interface WatchedTransport {
  /** The readable to hand to `ndJsonStream`, instrumented for end-of-stream. */
  readable: ReadableStream<Uint8Array>;
  /**
   * Rejects when the agent's stream ends or the signal aborts. Never resolves,
   * so it is safe to `Promise.race` against any request.
   */
  death: Promise<never>;
  /**
   * Report the connection as gone. A deliberate close must reject in-flight
   * requests too — once the transport is down nothing can ever answer them,
   * so leaving them pending would hang the caller just as a crash would.
   */
  shutdown(reason?: string): void;
}

/**
 * Instrument a transport so the death of the agent becomes an error.
 *
 * @public
 * @param agentId - Named in the resulting {@link AcpConnectError}.
 * @param transport - The transport whose readable is being consumed.
 * @param signal - Aborting this counts as death for in-flight requests.
 */
export function watchTransport(
  agentId: string,
  transport: AcpTransport,
  signal?: AbortSignal,
): WatchedTransport {
  let reject: ((reason: unknown) => void) | undefined;
  let settled = false;

  const death = new Promise<never>((_resolve, rejectFn) => {
    reject = rejectFn;
  });
  // Nothing may await `death` on its own — it only ever rejects, and an
  // unconsumed rejection would surface as an unhandled rejection the moment
  // the agent exits normally.
  death.catch(() => undefined);

  const die = (reason: string) => {
    if (settled) {
      return;
    }
    settled = true;
    reject?.(
      new AcpConnectError({
        agentId,
        message: `ACP agent '${agentId}' ${reason}, so in-flight requests can never be answered.`,
      }),
    );
  };

  const onAbort = () => die('was aborted');
  signal?.addEventListener('abort', onAbort, {
    once: true,
  });

  // A pass-through that reports end-of-stream. `flush` fires on a clean end,
  // `cancel` when the reader tears down early.
  const readable = transport.readable.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush() {
        die('closed its output stream');
      },
    }),
  );

  return {
    readable,
    death,
    shutdown(reason = 'connection was closed') {
      signal?.removeEventListener('abort', onAbort);
      die(reason);
    },
  };
}
