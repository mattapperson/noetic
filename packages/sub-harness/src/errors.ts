/**
 * Error types shared by sub-harness adapters.
 */

/**
 * Thrown by a sub-harness adapter when a requested optional capability (manual
 * compaction, suspend/continue, …) is not supported by the underlying agent.
 * @public
 */
export class SubHarnessCapabilityError extends Error {
  readonly harnessId: string;
  readonly capability: string;

  constructor(opts: {
    harnessId: string;
    capability: string;
    message?: string;
  }) {
    super(opts.message ?? `Sub-harness '${opts.harnessId}' does not support '${opts.capability}'.`);
    this.name = 'SubHarnessCapabilityError';
    this.harnessId = opts.harnessId;
    this.capability = opts.capability;
  }
}

/** @public Type guard for {@link SubHarnessCapabilityError}. */
export function isSubHarnessCapabilityError(e: unknown): e is SubHarnessCapabilityError {
  return e instanceof SubHarnessCapabilityError;
}

/**
 * Thrown when a sub-harness fails to start (CLI not installed, auth missing,
 * sandbox unreachable, …).
 * @public
 */
export class SubHarnessStartError extends Error {
  readonly harnessId: string;
  readonly startCause?: unknown;

  constructor(opts: {
    harnessId: string;
    message: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'SubHarnessStartError';
    this.harnessId = opts.harnessId;
    this.startCause = opts.cause;
  }
}

/** @public Type guard for {@link SubHarnessStartError}. */
export function isSubHarnessStartError(e: unknown): e is SubHarnessStartError {
  return e instanceof SubHarnessStartError;
}
