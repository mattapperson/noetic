import type { ConnectionMissing } from '../types/connection';
import { NoeticConfigError } from './noetic-config-error';

/** Describes a missing part in words, for the error message. */
function describeMissing(missing: ConnectionMissing): string {
  switch (missing.kind) {
    case 'profile':
      return `profile ${missing.profile}@${missing.range}`;
    case 'extension':
      return `extension ${missing.extension}@${missing.range}`;
    case 'operation':
      return `operation '${missing.op}'`;
    case 'event':
      return `event '${missing.event}'`;
    case 'sense':
      return `sense '${missing.sense}'`;
    default: {
      const _exhaustive: never = missing;
      void _exhaustive;
      return 'an unknown requirement';
    }
  }
}

/**
 * @public
 * `CONNECTION_UNSATISFIED`: a connection does not offer what is required.
 * `missing` says which — a profile or extension version, an operation, an
 * event, or a sense (spec 35 § Errors).
 */
export class ConnectionUnsatisfiedError extends NoeticConfigError {
  readonly connection: string;
  readonly missing: ConnectionMissing;

  constructor(opts: {
    connection: string;
    missing: ConnectionMissing;
    hint?: string;
  }) {
    super({
      code: 'CONNECTION_UNSATISFIED',
      message: `Connection '${opts.connection}' does not offer ${describeMissing(opts.missing)}.`,
      hint:
        opts.hint ??
        'Point the handle or manifest entry at a connection that implements it, or stop requiring it.',
    });
    this.name = 'ConnectionUnsatisfiedError';
    this.connection = opts.connection;
    this.missing = opts.missing;
  }
}

/** @public Type guard for `ConnectionUnsatisfiedError`. */
export function isConnectionUnsatisfiedError(e: unknown): e is ConnectionUnsatisfiedError {
  return e instanceof ConnectionUnsatisfiedError;
}
