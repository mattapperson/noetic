/** @public Lifecycle states for a detached (background) execution. */
const DetachedStatus = {
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
} as const;
type DetachedStatus = (typeof DetachedStatus)[keyof typeof DetachedStatus];

/** @public Handle returned by `detachedSpawn`, used to poll or await a background execution. */
interface DetachedHandle<O> {
  readonly id: string;
  readonly status: DetachedStatus;
  readonly result: O | undefined;
  readonly error: string | undefined;
  await(timeout?: number): Promise<O>;
}

export type { DetachedHandle };
export { DetachedStatus };
