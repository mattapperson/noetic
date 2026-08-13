/**
 * Shared types for the local subprocess adapter's extracted helpers.
 * Keeping these in a sibling module avoids a circular import between
 * `local-subprocess-adapter.ts` (the public entry) and the
 * `manifest-persistence.ts` helper it now delegates to.
 */

export type SubprocessSignal = 'SIGTERM' | 'SIGSTOP' | 'SIGCONT';

export interface ProcessSignaller {
  kill(target: number, signal: SubprocessSignal): void;
  isAlive(pid: number): boolean;
  /**
   * Stable start-time identity token for `pid`, or null when unreadable.
   * May be sync or async: the default signaller reads `/proc` (sync, µs) on
   * Linux and shells out to `ps` elsewhere; an async implementation lets a
   * host avoid blocking the event loop on that fork. Callers must await.
   */
  startTime(pid: number): string | null | Promise<string | null>;
}
