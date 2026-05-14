import type { ShellAdapter } from '@noetic-tools/core';
import { TIMEOUT_ERROR_PREFIX } from '@noetic-tools/core';
import type { MirageWorkspace } from './types';

//#region Helpers

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

//#endregion

//#region Public API

/**
 * Construct a `ShellAdapter` backed by a Mirage `Workspace`. Every
 * `exec` call dispatches through `workspace.execute`, which routes
 * each stage of the command (including pipes across mount boundaries)
 * to the correct per-mount handler.
 *
 * Cross-mount pipelines like
 * `cat /s3/x.csv | grep foo | head > /local/out.txt` work naturally
 * because Mirage's bash executor resolves each stage against the
 * appropriate backend. No real subprocess is spawned.
 *
 * Streaming: Mirage's `execute()` returns a Promise<Result> with final
 * stdout/stderr bytes. When `onData` is supplied we invoke it once
 * with the full stdout on completion. When Mirage exposes an
 * incremental stdout surface, this adapter will promote to streaming
 * with no call-site change.
 *
 * @public
 */
export function createMirageShellAdapter(workspace: MirageWorkspace): ShellAdapter {
  return {
    async exec(command, options) {
      const { cwd, env, timeout, stdin, signal, onData } = options;

      const controller = new AbortController();
      const signals: AbortSignal[] = [
        controller.signal,
      ];
      if (signal) {
        signals.push(signal);
      }
      // Compose user signal + our timeout controller via a simple
      // any-abort sentinel. Node's AbortSignal.any isn't universally
      // available in our targets, so use an adapter pattern.
      const composed = composeSignals(signals);

      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeout && timeout > 0) {
        timer = setTimeout(() => controller.abort(), timeout * 1e3);
      }

      try {
        const result = await workspace.execute(command, {
          cwd,
          env,
          stdin,
          signal: composed,
        });
        if (onData && result.stdout.byteLength > 0) {
          onData(Buffer.from(result.stdout));
        }
        return {
          stdout: decodeUtf8(result.stdout),
          stderr: decodeUtf8(result.stderr),
          exitCode: result.exitCode,
        };
      } catch (err) {
        if (controller.signal.aborted && timeout && timeout > 0) {
          throw new Error(`${TIMEOUT_ERROR_PREFIX}${timeout}`);
        }
        throw err;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}

//#endregion

//#region Signal Composition

function composeSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) {
    return signals[0];
  }
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), {
      once: true,
    });
  }
  return controller.signal;
}

//#endregion
