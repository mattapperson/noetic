/**
 * @noetic-tools/verify — implements the `Verifier` contract from
 * `@noetic-tools/types/verify` with `open-verification` (spec 37).
 */

/** @public The OVP item type a verification run is emitted as. */
export { VERIFICATION_RUN_ITEM_TYPE } from '@noetic-tools/types/verify';
export type {
  CountMethods,
  EventMatcherBuilder,
  EventVerifyMatcher,
  SenseMatcherBuilder,
  SenseVerifyMatcher,
  VerifyMatcherInput,
} from './matchers';
export { event, log, net, route, sense, signal, state, toVerifyMatcher, ui } from './matchers';
export { prepareVerify } from './prepare';
export type { VerifierOptions } from './verifier';
export { VERIFIER_NAME, VERIFIER_VERSION, verifier } from './verifier';
