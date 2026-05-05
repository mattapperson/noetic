import { nowIso, serializeError } from './metadata';
import type { CompleteProcessRunParams, CompleteStepRunParams } from './types';

//#region Completion handlers

export async function completeProcessRun({
  request,
  handle,
  run,
  handles,
  active,
  save,
  clearIfDurable,
}: CompleteProcessRunParams): Promise<void> {
  try {
    await run?.(request, handle);
    const latest = handles.get(handle.id);
    if (!latest || latest.status !== 'running') {
      return;
    }
    active.delete(handle.id);
    await save({
      ...latest,
      status: 'completed',
      updatedAt: nowIso(),
    });
    // Clear the durable handle manifest once the run has terminated so
    // `listLive()` stops returning this handle. Without this call the
    // manifest would persist until `stop()` was called, making every
    // completed step look live from the adapter's persistence layer.
    await clearIfDurable(handle.id);
  } catch (err) {
    active.delete(handle.id);
    const latest = handles.get(handle.id) ?? handle;
    await save({
      ...latest,
      status: 'failed',
      updatedAt: nowIso(),
      metadata: {
        ...(latest.metadata ?? {}),
        error: serializeError(err),
      },
    });
    // Same rationale as the success branch above — clear the durable
    // manifest so `listLive()` doesn't resurrect this handle on reboot.
    await clearIfDurable(handle.id);
  }
}

export async function completeStepRun({
  request,
  handle,
  stepRunner,
  handles,
  active,
  save,
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
    const latest = handles.get(handle.id);
    if (!latest || latest.status !== 'running') {
      return;
    }
    active.delete(handle.id);
    await save({
      ...latest,
      status: 'completed',
      updatedAt: nowIso(),
      metadata: {
        ...(latest.metadata ?? {}),
        result,
      },
    });
    // Clear the durable step manifest once the run has terminated —
    // see `completeProcessRun` above for the rationale.
    await clearIfDurable(handle.id);
  } catch (err) {
    active.delete(handle.id);
    const latest = handles.get(handle.id) ?? handle;
    await save({
      ...latest,
      status: 'failed',
      updatedAt: nowIso(),
      metadata: {
        ...(latest.metadata ?? {}),
        error: serializeError(err),
      },
    });
    await clearIfDurable(handle.id);
  }
}

//#endregion
