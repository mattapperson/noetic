import type { Context, SpawnedSubprocess, StorageAdapter } from '@noetic-tools/types';
import {
  frameworkCast,
  isNoeticConfigError,
  NoeticErrorImpl,
  SubprocessLaunchError,
} from '@noetic-tools/types';
import { ContextImpl } from '../runtime/context-impl';
import { StepIntent } from '../runtime/durable/step-intent';
import { commandLaunchers } from '../util/workflow-command';
import { pendingEntryKey, runRootOf } from './connection-steps';
import type { StepKindScope } from './step-kind-dispatch';

/** Keep a dispatch until its result lands. A refusal disarms the intent. */
export function stepLaunch<TContext>({
  scope,
  stepId,
  slot,
  external,
}: {
  scope: StepKindScope<TContext>;
  stepId: string;
  slot: 'subprocess' | 'command';
  external: boolean;
}) {
  const { stepCtx: ctx, ledgerKey } = scope;
  const ledger = ctx instanceof ContextImpl ? ctx.ledger : undefined;
  const storage = frameworkCast<{
    config?: {
      storage?: StorageAdapter;
    };
  }>(ctx.harness).config?.storage;
  const pending =
    storage && ledger && ledgerKey !== undefined && (external || ledger.mayHavePending)
      ? new StepIntent(
          storage,
          pendingEntryKey(runRootOf(frameworkCast<Context>(ctx)).id, `${ledgerKey}/${slot}`),
          ledger,
        )
      : undefined;
  const saved = external ? pending : undefined;
  const unknown = (cause?: unknown) =>
    new NoeticErrorImpl({
      kind: 'subprocess_outcome_unknown',
      stepId,
      ...(cause === undefined
        ? {}
        : {
            cause: cause instanceof Error ? cause : new Error(String(cause)),
          }),
    });
  let checked = false;
  let sent = false;
  let cleanup = false;
  async function check(): Promise<void> {
    if (!checked && pending && (await pending.read()) !== null) {
      throw unknown();
    }
    checked = true;
  }
  return {
    check,
    canRetry: () => !sent,
    async send(
      spawn: () => Promise<SpawnedSubprocess>,
      preLaunch = () => true,
    ): Promise<SpawnedSubprocess> {
      if (!external) {
        return spawn();
      }
      if (sent) {
        throw unknown();
      }
      await check();
      await saved?.write({
        kind: slot,
        stepId,
      });
      if (ctx.aborted) {
        await saved?.clear();
        throw new NoeticErrorImpl({
          kind: 'cancelled',
          reason: ctx.abortReason ?? 'context aborted',
        });
      }
      sent = true;
      if (saved && !cleanup) {
        cleanup = true;
        scope.onRecorded(async (stored) => {
          if (stored) {
            await saved.clear().catch(() => undefined);
          }
        });
      }
      try {
        const spawned = await spawn();
        return {
          ...spawned,
          settled: spawned.settled.then(
            (handle) => {
              if (
                slot === 'command' &&
                handle.status === 'failed' &&
                typeof handle.metadata?.exitCode === 'number'
              ) {
                sent = false;
              }
              return handle;
            },
            (error: unknown) => {
              throw unknown(error);
            },
          ),
        };
      } catch (error) {
        if (preLaunch() && refusedLaunch(error)) {
          await saved?.clear();
          sent = false;
          throw error;
        }
        throw unknown(error);
      }
    },
  };
}

function refusedLaunch(error: unknown): boolean {
  return (
    error instanceof SubprocessLaunchError ||
    (isNoeticConfigError(error) &&
      (error.code === 'SUBPROCESS_RUNS_NO_STEPS' || error.code === 'SUBPROCESS_CANNOT_END_INPUT'))
  );
}

/** Bind a document command's launch to the step that owns its result. */
export async function withCommandLauncher<T>(
  ctx: Context,
  launch: ReturnType<typeof stepLaunch>,
  run: () => Promise<T>,
): Promise<T> {
  commandLaunchers.set(ctx, {
    spawn: (adapter, request) => launch.send(() => adapter.spawn(request)),
    canRetry: launch.canRetry,
  });
  try {
    return await run();
  } finally {
    commandLaunchers.delete(ctx);
  }
}
