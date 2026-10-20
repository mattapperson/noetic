/**
 * Child-process fixture for the `serveAcp` smoke test: serves a minimal
 * structural harness over the CURRENT process's stdio and exits when the
 * client disconnects — exactly the deployment shape an editor launches.
 */

import type { ExecuteOptions, StreamEvent } from '@noetic-tools/types';
import type { AcpServeHarness } from '../../src/serve-types';
import { serveAcp } from '../../src/server';

function stubHarness(): AcpServeHarness {
  const buffer: StreamEvent[] = [];
  const wakeups: Array<() => void> = [];

  const emit = (event: StreamEvent): void => {
    buffer.push(event);
    for (const wake of wakeups.splice(0)) {
      wake();
    }
  };

  const emitTurn = (options: ExecuteOptions | undefined): void => {
    const messageId = options?.messageId ?? 'unknown';
    emit({
      source: 'framework',
      type: 'stdio-stub:turn_started',
      data: {
        turnId: 'turn-1',
        messageIds: [
          messageId,
        ],
      },
    });
    emit({
      source: 'sdk',
      type: 'response.output_text.delta',
      data: {
        delta: 'hello over stdio',
      },
    });
    emit({
      source: 'framework',
      type: 'stdio-stub:turn_completed',
      data: {
        turnId: 'turn-1',
        durationMs: 1,
      },
    });
  };

  return {
    execute(_input, options) {
      emitTurn(options);
      return Promise.resolve();
    },
    getFullStream() {
      let cursor = 0;
      return {
        [Symbol.asyncIterator]: () => ({
          async next(): Promise<IteratorResult<StreamEvent>> {
            while (cursor >= buffer.length) {
              await new Promise<void>((resolve) => {
                wakeups.push(resolve);
              });
            }
            const value = buffer[cursor];
            cursor += 1;
            if (value === undefined) {
              return {
                value: undefined,
                done: true,
              };
            }
            return {
              value,
              done: false,
            };
          },
          async return(): Promise<IteratorResult<StreamEvent>> {
            return {
              value: undefined,
              done: true,
            };
          },
        }),
      };
    },
    async *getItemStream() {},
    seedSessionHistory: () => undefined,
    abort: () => Promise.resolve(),
  };
}

await serveAcp(stubHarness()).closed;
process.exit(0);
