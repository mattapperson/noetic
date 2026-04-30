import type { TaskStoreContext } from '../fs-store.js';
import type { Slice } from './schemas.js';
import { SliceStatus } from './schemas.js';
import { loadSlice, saveSlice } from './store.js';
import type { TriageContext } from './triage.js';
import { triageSlice } from './triage.js';

//#region Types

export interface ActivateSliceArgs {
  readonly parentTaskId: string;
  readonly sliceId: string;
  /**
   * If true, immediately spawn leaf tasks for every un-triaged feature
   * in the slice. The autopilot daemon decides this based on whether
   * the parent task has autopilotEnabled.
   */
  readonly triage?: boolean;
}

export interface ActivateSliceResult {
  readonly slice: Slice;
  readonly triaged: ReturnType<typeof triageSlice> extends Promise<infer R> ? R : never;
  readonly didTriage: boolean;
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

//#endregion

//#region Public API

/**
 * Mark a slice as active. Optionally triages every un-linked feature
 * in the slice into a placeholder leaf task. Mirrors the legacy
 * `activateSlice` (without the legacy autopilotEnabled side-channel —
 * the caller passes `triage` explicitly so the daemon's gating logic
 * stays where it belongs).
 */
export async function activateSlice(
  ctx: TaskStoreContext,
  args: ActivateSliceArgs,
): Promise<ActivateSliceResult> {
  const slice = await loadSlice(ctx, args.parentTaskId, args.sliceId);
  if (slice === null) {
    throw new Error(`Slice ${args.sliceId} not found in task ${args.parentTaskId}`);
  }
  const next: Slice = {
    ...slice,
    status: SliceStatus.Active,
    updatedAt: nowIso(),
  };
  await saveSlice(ctx, args.parentTaskId, next);

  if (args.triage !== true) {
    return {
      slice: next,
      triaged: {
        summaries: [],
        created: [],
      },
      didTriage: false,
    };
  }

  const triageCtx: TriageContext = {
    ...ctx,
    parentTaskId: args.parentTaskId,
  };
  const triaged = await triageSlice(triageCtx, args.sliceId);
  return {
    slice: next,
    triaged,
    didTriage: true,
  };
}

//#endregion
