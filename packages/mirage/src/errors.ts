/**
 * Typed errors thrown by the Mirage-backed adapters.
 *
 * Splitting these out from core's `NoeticError` union keeps the
 * Mirage bridge's failure modes local to `@noetic/mirage`. Catch by
 * instance check; the message carries the mount path, operation, and
 * upstream stderr for diagnostics.
 */

export type MirageErrorKind = 'io_failed' | 'resource_op_unsupported';

/** @public Error thrown by Mirage-backed `FsAdapter` / `ShellAdapter`. */
export class MirageError extends Error {
  readonly kind: MirageErrorKind;
  readonly operation: string;
  readonly path: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: {
    kind: MirageErrorKind;
    operation: string;
    path: string;
    exitCode: number | null;
    stderr: string;
  }) {
    super(
      `${args.kind === 'resource_op_unsupported' ? 'resource does not support' : 'failed'} ${args.operation}(${args.path})${args.stderr ? `: ${args.stderr}` : ` (exit ${args.exitCode ?? 'null'})`}`,
    );
    this.name = 'MirageError';
    this.kind = args.kind;
    this.operation = args.operation;
    this.path = args.path;
    this.exitCode = args.exitCode;
    this.stderr = args.stderr;
  }
}

/** @public Type guard for `MirageError`. */
export function isMirageError(value: unknown): value is MirageError {
  return value instanceof MirageError;
}
