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
  startTime(pid: number): string | null;
}
