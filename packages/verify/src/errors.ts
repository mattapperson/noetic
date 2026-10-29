/**
 * Error helpers for `@noetic-tools/verify` (spec 37 § Errors).
 */

import { NoeticConfigError } from '@noetic-tools/types';
import { VerifyConfigErrorCode } from '@noetic-tools/types/verify';

//#region Public API

/**
 * A `VERIFY_INVALID` config error: a matcher the sense's grammar cannot parse, a
 * malformed verify, or a witness asked to act.
 */
export function verifyInvalid(message: string, hint?: string): NoeticConfigError {
  return new NoeticConfigError({
    code: VerifyConfigErrorCode.Invalid,
    message,
    hint:
      hint ??
      'Write each matcher in its sense grammar (spec 36 § Senses) and give a verify exactly one of expect or claims.',
  });
}

//#endregion
