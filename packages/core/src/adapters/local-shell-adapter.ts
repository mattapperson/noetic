import {
  type ShellAdapter,
  type ShellExecResult,
  TIMEOUT_ERROR_PREFIX,
} from '../types/shell-adapter';

//#region Helpers

function readStream(
  stream: ReadableStream<Uint8Array>,
  onData?: (data: Buffer) => void,
): Promise<string> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();

  async function pump(): Promise<string> {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const buf = Buffer.from(value);
      chunks.push(buf);
      onData?.(buf);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  return pump();
}

//#endregion

//#region Public API

/** Create a ShellAdapter backed by the local system shell via `Bun.spawn`. */
export function createLocalShellAdapter(): ShellAdapter {
  return {
    async exec(command, options): Promise<ShellExecResult> {
      const proc = Bun.spawn(
        [
          'sh',
          '-c',
          command,
        ],
        {
          cwd: options.cwd,
          env: options.env
            ? {
                ...process.env,
                ...options.env,
              }
            : undefined,
          stdin: options.stdin
            ? new Blob([
                options.stdin,
              ])
            : undefined,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutSeconds = options.timeout;
      if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutSeconds * 1e3);
      }

      const abortHandler = (): void => {
        proc.kill();
      };
      if (options.signal) {
        options.signal.addEventListener('abort', abortHandler, {
          once: true,
        });
      }

      try {
        const [stdout, stderr] = await Promise.all([
          readStream(proc.stdout, options.onData),
          readStream(proc.stderr, options.onData),
        ]);

        const exitCode = await proc.exited;

        // Only timeout throws. Signal-driven aborts resolve normally so
        // callers can decide via their own state whether the result is
        // a real exit or a cancellation (see runUserShellCommand).
        if (timedOut) {
          throw new Error(`${TIMEOUT_ERROR_PREFIX}${timeoutSeconds}`);
        }

        return {
          stdout,
          stderr,
          exitCode,
        };
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (options.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }
      }
    },
  };
}

//#endregion
