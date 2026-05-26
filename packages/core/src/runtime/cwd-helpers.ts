import type { Context, CwdState } from '../types/context';

/**
 * @public Resolve the live cwd for a tool execution. Falls back to the
 * tool's factory-time cwd (then `process.cwd()`) so partial test contexts
 * without a `cwdState` keep working.
 */
export function getToolCwd(ctx: Context | undefined, fallback?: string): string {
  return ctx?.cwdState?.cwd ?? fallback ?? process.cwd();
}

/**
 * @public Update the shared cwd state for a Context. Callers MUST pass an
 * absolute, normalized path — validation (`statSync`, `~` expansion, etc.)
 * is the caller's responsibility.
 *
 * No-op when `nextCwd` equals the current cwd: leaves `previousCwd` alone
 * so a `cd .` (or any redundant cd to the same path) does not stomp the
 * preserved OLDPWD that powers `cd -`.
 */
export function setToolCwd(
  ctx: Context,
  nextCwd: string,
): {
  previousCwd: string;
  newCwd: string;
} {
  const currentCwd = ctx.cwdState.cwd;
  if (nextCwd === currentCwd) {
    return {
      previousCwd: ctx.cwdState.previousCwd ?? currentCwd,
      newCwd: currentCwd,
    };
  }
  const previousCwd = ctx.cwdState.cwd;
  ctx.cwdState.previousCwd = previousCwd;
  ctx.cwdState.cwd = nextCwd;
  return {
    previousCwd,
    newCwd: nextCwd,
  };
}

/**
 * @public Snapshot a parent's cwd state for a child Context. Spawned/forked
 * children must not share the parent's `CwdState` reference — POSIX-fork
 * semantics require child mutations stay local to the child.
 */
export function snapshotCwdState(parent: Context): CwdState {
  return {
    cwd: parent.cwdState.cwd,
    previousCwd: parent.cwdState.previousCwd,
  };
}

/**
 * @internal Briefly retarget `cwdState.cwd` so an immediately-following
 * `executeSpawn` snapshots `nextCwd` onto the spawned child, then restore
 * the parent's prior cwd via the returned callback.
 *
 * Unlike {@link setToolCwd}, this does NOT update `previousCwd` — the
 * retarget is invisible to the parent's logical cd history (it only exists
 * to seed the child's snapshot). The bypass is the entire reason this
 * helper is separate from `setToolCwd`.
 *
 * Safe ONLY when the caller holds exclusive use of the context for the
 * duration of the retarget — typically a sync spawn that awaits before
 * restoring. `harness.run()` returns a Promise (not an iterator) so no
 * yield occurs between retarget and restore.
 */
export function retargetCwdForSpawn(ctx: Context, nextCwd: string): () => void {
  const savedCwd = ctx.cwdState.cwd;
  const savedPrev = ctx.cwdState.previousCwd;
  ctx.cwdState.cwd = nextCwd;
  return () => {
    ctx.cwdState.cwd = savedCwd;
    ctx.cwdState.previousCwd = savedPrev;
  };
}
