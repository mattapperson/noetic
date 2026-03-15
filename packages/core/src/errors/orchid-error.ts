import type { OrchidError } from '../types/error';

export class OrchidErrorImpl extends Error {
  readonly orchidError: OrchidError;

  constructor(error: OrchidError) {
    super(formatMessage(error));
    this.name = 'OrchidError';
    this.orchidError = error;
  }
}

export function isOrchidError(e: unknown): e is OrchidErrorImpl {
  return e instanceof OrchidErrorImpl;
}

function formatMessage(error: OrchidError): string {
  switch (error.kind) {
    case 'step_failed':
      return `Step '${error.stepId}' failed: ${error.cause.message}`;
    default:
      return `OrchidError: ${error.kind}`;
  }
}
