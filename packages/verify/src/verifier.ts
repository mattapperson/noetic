/**
 * `verifier()`: the `Verifier` contract from `@noetic-tools/types/verify`,
 * implemented with `open-verification` (spec 37 § Under the hood). The harness
 * registers it once: `new AgentHarness({ verification: verifier() })`.
 */

import type { Verifier } from '@noetic-tools/types/verify';
import { prepareVerify } from './prepare';
import { runVerify } from './run';

//#region Constants

/** @public This package's version, written into every run document. */
export const VERIFIER_VERSION = '0.1.0';

/** @public The default verifier name in run documents. */
export const VERIFIER_NAME = '@noetic-tools/verify';

//#endregion

//#region Public API

/** @public Options for `verifier()`. */
export interface VerifierOptions {
  /** The verifier name written into run documents. Default `@noetic-tools/verify`. */
  readonly name?: string;
}

/**
 * @public
 * The verifier `step.verify` uses. OVP's own `adjudicate()` decides every
 * verdict; a run is an OVP `VerificationRun` any OVP tool can read and check.
 */
export function verifier(options?: VerifierOptions): Verifier {
  const info = {
    name: options?.name ?? VERIFIER_NAME,
    version: VERIFIER_VERSION,
  };
  return {
    name: info.name,
    version: info.version,
    prepare: prepareVerify,
    run: (prepared, host) =>
      runVerify({
        prepared,
        host,
        verifier: info,
      }),
  };
}

//#endregion
