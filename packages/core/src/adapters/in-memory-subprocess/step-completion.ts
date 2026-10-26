import type { SubprocessHandle } from '@noetic-tools/types';
import { nowIso, serializeError } from './metadata';
import type { CompleteProcessRunParams, CompleteStepRunParams } from './types';

//#region Completion handlers

export async function completeProcessRun({
  request,
  handle,
  run,
  live,
  clearIfDurable,
}: CompleteProcessRunParams): Promise<void> {
  try {
    await run?.(request, handle);
    await finish(
      {
        live,
        clearIfDurable,
      },
      handle.id,
      {
        status: 'completed',
      },
    );
  } catch (err) {
    await finish(
      {
        live,
        clearIfDurable,
      },
      handle.id,
      {
        status: 'failed',
        error: serializeError(err),
      },
    );
  }
}

export async function completeStepRun({
  request,
  handle,
  stepRunner,
  live,
  clearIfDurable,
}: CompleteStepRunParams): Promise<void> {
  try {
    const executor = request._localExecutor;
    let result: unknown;
    if (executor) {
      result = await executor();
    } else if (stepRunner) {
      result = await stepRunner(request, handle);
    } else {
      throw new Error(
        `In-memory subprocess adapter has no executor for step "${request.stepId}". ` +
          'Provide a stepRunner option or dispatch via AgentHarness.',
      );
    }
    await finish(
      {
        live,
        clearIfDurable,
      },
      handle.id,
      {
        status: 'completed',
        result,
      },
    );
  } catch (err) {
    await finish(
      {
        live,
        clearIfDurable,
      },
      handle.id,
      {
        status: 'failed',
        error: serializeError(err),
      },
    );
  }
}

//#endregion

//#region Helpers

interface Outcome {
  status: 'completed' | 'failed';
  result?: unknown;
  error?: ReturnType<typeof serializeError>;
}

/**
 * Settles a run that ended on its own. The caller hears first; the durable
 * manifest clears after, so a slow storage write never delays the result.
 * A handle already stopped has settled, so its late outcome is dropped.
 */
async function finish(
  { live, clearIfDurable }: Pick<CompleteStepRunParams, 'live' | 'clearIfDurable'>,
  handleId: string,
  outcome: Outcome,
): Promise<void> {
  const latest = live.get(handleId);
  if (!latest) {
    return;
  }
  const metadata: SubprocessHandle['metadata'] = {
    ...(latest.metadata ?? {}),
  };
  if (outcome.result !== undefined) {
    metadata.result = outcome.result;
  }
  if (outcome.error !== undefined) {
    metadata.error = outcome.error;
  }
  live.settle({
    ...latest,
    status: outcome.status,
    updatedAt: nowIso(),
    metadata,
  });
  await clearIfDurable(handleId);
}

//#endregion
