/**
 * Resolves ACP `session/request_permission` calls.
 *
 * ACP makes permission a baseline client responsibility: before running a tool
 * the agent asks, and offers a set of {@link AcpPermissionOption}s to choose
 * from. Noetic answers in three tiers, first decisive one wins:
 *
 *   1. the step's declarative {@link AcpPermissionPolicy},
 *   2. the steering pipeline (supplied by the caller as `steer`), so one rule
 *      set governs both LLM tool calls and sub-agent tool calls,
 *   3. the async `onPermissionRequest` handler — the human-in-the-loop hatch
 *      that steering's synchronous predicate cannot express.
 *
 * When all three abstain the policy `default` applies, which is `deny` unless
 * the step says otherwise: an unattended agent must not gain blanket approval
 * by omission.
 */

import type {
  AcpBoundPermissionHandler,
  AcpPermissionDecision,
  AcpPermissionOption,
  AcpPermissionOutcome,
  AcpPermissionPolicy,
  AcpPermissionRule,
  AcpPermissionSteerer,
  AcpRequestPermissionRequest,
} from '@noetic-tools/types';

//#region Types

/** @public Everything {@link resolvePermission} consults, in tier order. */
export interface AcpPermissionResolverOptions {
  policy?: AcpPermissionPolicy;
  steer?: AcpPermissionSteerer;
  handler?: AcpBoundPermissionHandler;
}

/** The concrete ACP outcome payload sent back to the agent. */
export type AcpRequestPermissionOutcome =
  | {
      outcome: 'cancelled';
    }
  | {
      outcome: 'selected';
      optionId: string;
    };

//#endregion

//#region Policy evaluation

/** True when every present field of the rule matches the tool call. */
export function ruleMatches(
  rule: AcpPermissionRule,
  toolCall: AcpRequestPermissionRequest['toolCall'],
): boolean {
  if (rule.kind !== undefined && toolCall.kind !== rule.kind) {
    return false;
  }
  if (rule.title === undefined) {
    return true;
  }
  const title = toolCall.title ?? '';
  if (rule.title instanceof RegExp) {
    return rule.title.test(title);
  }
  return title.toLowerCase().includes(rule.title.toLowerCase());
}

/**
 * Evaluate the declarative policy. `deny` is checked before `allow` so an
 * explicit refusal always beats a broad grant. Returns `undefined` when no rule
 * matched, leaving the decision to the later tiers.
 */
export function evaluatePolicy(
  policy: AcpPermissionPolicy | undefined,
  request: AcpRequestPermissionRequest,
): AcpPermissionOutcome | undefined {
  if (!policy) {
    return undefined;
  }
  const matched = (rules?: ReadonlyArray<AcpPermissionRule>): AcpPermissionRule | undefined =>
    rules?.find((rule) => ruleMatches(rule, request.toolCall));

  const denied = matched(policy.deny);
  if (denied) {
    return {
      decision: 'deny',
      reason: 'matched a deny rule in the step permission policy',
    };
  }
  const allowed = matched(policy.allow);
  if (allowed) {
    return {
      decision: 'allow',
      reason: 'matched an allow rule in the step permission policy',
    };
  }
  return undefined;
}

//#endregion

//#region Option selection

const ALLOW_KINDS_ONCE_FIRST = [
  'allow_once',
  'allow_always',
] as const;
const ALLOW_KINDS_ALWAYS_FIRST = [
  'allow_always',
  'allow_once',
] as const;
const REJECT_KINDS_ONCE_FIRST = [
  'reject_once',
  'reject_always',
] as const;
const REJECT_KINDS_ALWAYS_FIRST = [
  'reject_always',
  'reject_once',
] as const;

function preferenceFor(
  decision: AcpPermissionDecision,
  persist: boolean,
): ReadonlyArray<AcpPermissionOption['kind']> {
  if (decision === 'allow') {
    return persist ? ALLOW_KINDS_ALWAYS_FIRST : ALLOW_KINDS_ONCE_FIRST;
  }
  return persist ? REJECT_KINDS_ALWAYS_FIRST : REJECT_KINDS_ONCE_FIRST;
}

/**
 * Translate a decision into one of the options the agent actually offered.
 *
 * An explicit `optionId` wins when the agent offered it. Otherwise the decision
 * picks by option `kind`, honouring `persist`.
 *
 * `cancelled` is reserved. The specification defines it as *the prompt turn was
 * cancelled* — a conforming agent that receives it aborts the whole turn and
 * answers `stopReason: 'cancelled'`. Returning it for a merely-denied tool
 * therefore kills the entire step over one refusal, so a deny falls back to any
 * reject option the agent offered, in either flavour, before giving up.
 *
 * When the agent genuinely offered nothing usable, {@link selectPermissionOption}
 * returns `undefined` and the caller raises a Noetic-side error rather than
 * telling the agent something untrue.
 */
export function selectPermissionOption(
  outcome: AcpPermissionOutcome,
  options: ReadonlyArray<AcpPermissionOption>,
  persist = false,
): AcpRequestPermissionOutcome | undefined {
  // The one case where `cancelled` is the truth: the decision really is
  // "abandon this turn".
  if (outcome.decision === 'cancel') {
    return {
      outcome: 'cancelled',
    };
  }
  if (outcome.optionId !== undefined) {
    const exact = options.find((option) => option.optionId === outcome.optionId);
    if (exact) {
      return {
        outcome: 'selected',
        optionId: exact.optionId,
      };
    }
  }
  for (const kind of preferenceFor(outcome.decision, persist)) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return {
        outcome: 'selected',
        optionId: match.optionId,
      };
    }
  }
  return undefined;
}

//#endregion

//#region Public API

/** Run the three resolver tiers and fall back to the policy default. */
export async function resolvePermission(
  request: AcpRequestPermissionRequest,
  opts: AcpPermissionResolverOptions,
): Promise<AcpPermissionOutcome> {
  const fromPolicy = evaluatePolicy(opts.policy, request);
  if (fromPolicy) {
    return fromPolicy;
  }
  if (opts.steer) {
    const steered = await opts.steer(request);
    if (steered) {
      return steered;
    }
  }
  if (opts.handler) {
    return await opts.handler(request);
  }
  return {
    decision: opts.policy?.default ?? 'deny',
    reason: 'no permission rule, steering decision, or handler matched',
  };
}

//#endregion
