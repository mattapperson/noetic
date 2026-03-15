import type { OrchidError } from '../types/error';

export class OrchidErrorImpl extends Error {
  readonly orchidError: OrchidError;
  constructor(error: OrchidError) {
    super(`OrchidError: ${error.kind}`);
    this.name = 'OrchidError';
    this.orchidError = error;
  }
}

export function isOrchidError(e: unknown): e is OrchidErrorImpl {
  return e instanceof OrchidErrorImpl;
}
