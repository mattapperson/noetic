/**
 * Spawn an install command and stream its output line-by-line.
 *
 * The TUI screen consumes this async iterable to render a live tail and to
 * know when the process has exited. We interleave stdout and stderr into a
 * single stream since users don't care which is which — they care about
 * "what's happening" and "did it succeed".
 */

import type { InstallOption } from './types.js';

//#region Types

export type InstallEvent =
  | {
      kind: 'line';
      stream: 'stdout' | 'stderr';
      text: string;
    }
  | {
      kind: 'exited';
      exitCode: number;
    };

export interface InstallHandle {
  events: AsyncIterable<InstallEvent>;
  cancel(): void;
}

//#endregion

//#region Implementation

async function* readLines(
  stream: ReadableStream<Uint8Array>,
  which: 'stdout' | 'stderr',
): AsyncIterable<InstallEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, {
      stream: true,
    });
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      yield {
        kind: 'line',
        stream: which,
        text: line,
      };
      idx = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) {
    yield {
      kind: 'line',
      stream: which,
      text: buffer,
    };
  }
}

async function* merge(
  a: AsyncIterable<InstallEvent>,
  b: AsyncIterable<InstallEvent>,
): AsyncIterable<InstallEvent> {
  const itA = a[Symbol.asyncIterator]();
  const itB = b[Symbol.asyncIterator]();
  const pending: Promise<{
    from: 'a' | 'b';
    result: IteratorResult<InstallEvent>;
  }>[] = [
    itA.next().then((result) => ({
      from: 'a',
      result,
    })),
    itB.next().then((result) => ({
      from: 'b',
      result,
    })),
  ];
  let doneA = false;
  let doneB = false;
  while (!(doneA && doneB)) {
    const settled = await Promise.race(
      pending.filter((_, i) => !((i === 0 && doneA) || (i === 1 && doneB))),
    );
    const which = settled.from;
    const idx = which === 'a' ? 0 : 1;
    if (settled.result.done) {
      if (which === 'a') {
        doneA = true;
      } else {
        doneB = true;
      }
      continue;
    }
    yield settled.result.value;
    const iter = which === 'a' ? itA : itB;
    pending[idx] = iter.next().then((result) => ({
      from: which,
      result,
    }));
  }
}

export function runInstallCommand(option: InstallOption): InstallHandle {
  const proc = Bun.spawn({
    cmd: [
      option.command,
      ...option.args,
    ],
    cwd: option.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  async function* stream(): AsyncIterable<InstallEvent> {
    yield* merge(readLines(proc.stdout, 'stdout'), readLines(proc.stderr, 'stderr'));
    const exitCode = await proc.exited;
    yield {
      kind: 'exited',
      exitCode,
    };
  }

  return {
    events: stream(),
    cancel: () => {
      proc.kill('SIGTERM');
    },
  };
}

//#endregion
