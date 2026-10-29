/**
 * A connection's `policy` (spec 35 § Gates, gate 4): `allow`, `deny` and
 * `approve` globs over operation names. `deny` wins; a non-empty `allow` list
 * refuses everything it does not match; `approve` matches need approval.
 * Operations a profile marks `guarded` need approval unless `allow` names
 * them explicitly.
 */

import type { ConnectionPolicy } from '@noetic-tools/types';
import { matchesAnyGlob } from './glob';

//#region Types

/** What the policy says about one call. */
export type PolicyVerdict =
  | {
      readonly kind: 'deny';
      readonly reason: string;
    }
  | {
      readonly kind: 'allow';
      /** The call must be approved before it is sent. */
      readonly needsApproval: boolean;
      /** `allow` names the operation, so a server's `guarded` refusal needs no approval. */
      readonly explicitlyAllowed: boolean;
    };

//#endregion

//#region Public API

/** Applies `policy` to operation `op` (`guarded` from the operation's info). */
export function evaluatePolicy(
  policy: ConnectionPolicy | undefined,
  op: string,
  guarded: boolean,
): PolicyVerdict {
  if (matchesAnyGlob(policy?.deny, op)) {
    return {
      kind: 'deny',
      reason: `operation '${op}' is denied by the connection policy`,
    };
  }
  const allowList = policy?.allow;
  const explicitlyAllowed = matchesAnyGlob(allowList, op);
  if (allowList && allowList.length > 0 && !explicitlyAllowed) {
    return {
      kind: 'deny',
      reason: `operation '${op}' is not in the connection policy's allow list`,
    };
  }
  const approve = matchesAnyGlob(policy?.approve, op);
  return {
    kind: 'allow',
    needsApproval: approve || (guarded && !explicitlyAllowed),
    explicitlyAllowed,
  };
}

//#endregion
