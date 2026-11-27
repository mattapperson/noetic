import type { NoeticError } from '../types/error';

/**
 * Runtime error thrown during step execution (LLM failures, fork failures, budget exceeded, etc.).
 *
 * @public
 */
export class NoeticErrorImpl extends Error {
  readonly noeticError: NoeticError;

  constructor(error: NoeticError) {
    const cause = causeOf(error);
    super(
      formatMessage(error),
      cause === undefined
        ? undefined
        : {
            cause,
          },
    );
    this.name = 'NoeticError';
    this.noeticError = error;
  }
}

/** The error a `NoeticError` wraps, when its kind carries one: it becomes the standard `Error.cause`. */
function causeOf(error: NoeticError): Error | undefined {
  if ('cause' in error) {
    return error.cause;
  }
  if (error.kind === 'spawn_summary_failed') {
    return error.summaryCause;
  }
  return undefined;
}

const MAX_CAUSE_DEPTH = 32;

/**
 * The error a failure started from: follows `cause` through every `NoeticError` that
 * wraps one (a `step_failed` from each code step the error crossed) and returns the
 * first value that is not a `NoeticError`. A `NoeticError` with no cause (`cancelled`,
 * `budget_exceeded`, ...) is returned as is, and so is any other value.
 *
 * @public
 * @param e - A caught value.
 * @returns The thrown value at the bottom of the chain.
 */
export function failureCause(e: unknown): unknown {
  let current = e;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!isNoeticError(current) || current.cause === undefined) {
      return current;
    }
    current = current.cause;
  }
  return current;
}

/**
 * Type guard for `NoeticErrorImpl`.
 *
 * Uses an `instanceof` fast path, then falls back to a structural check
 * (`Error` carrying a `noeticError.kind: string`). The fallback keeps the
 * guard reliable when multiple copies of `@noetic-tools/types` are loaded
 * (e.g. mixed `src`/`dist` resolution or duplicated node_modules), where
 * `instanceof` fails across realms. The inner `kind` is deliberately not
 * validated against the closed `NoeticError` union so errors minted by a
 * newer copy of the package still pass (forward compatibility).
 *
 * @public
 * @param e - Value to check.
 * @returns `true` if `e` is a `NoeticErrorImpl` (or structurally equivalent).
 */
export function isNoeticError(e: unknown): e is NoeticErrorImpl {
  if (e instanceof NoeticErrorImpl) {
    return true;
  }
  if (!(e instanceof Error)) {
    return false;
  }
  if (!('noeticError' in e)) {
    return false;
  }
  const inner = e.noeticError;
  return (
    typeof inner === 'object' && inner !== null && 'kind' in inner && typeof inner.kind === 'string'
  );
}

function formatMessage(error: NoeticError): string {
  switch (error.kind) {
    case 'step_failed':
      return `Step '${error.stepId}' failed: ${error.cause.message}`;
    case 'model_refused':
      return `Model refused at step '${error.stepId}': ${error.refusal}`;
    case 'model_parse_error':
      return `Model parse error at step '${error.stepId}': failed to parse output`;
    case 'model_rate_limit':
      return `Model rate limited at step '${error.stepId}'${error.retryAfter ? ` (retry after ${error.retryAfter}ms)` : ''}`;
    case 'fork_partial':
      return `Fork '${error.stepId}' partial failure: ${error.succeeded.length} succeeded, ${error.failed.length} failed`;
    case 'spawn_summary_failed':
      return `Spawn '${error.stepId}' summary failed: ${error.summaryCause.message}`;
    case 'channel_timeout':
      return `Channel '${error.channelName}' timed out after ${error.timeout}ms`;
    case 'channel_closed':
      return `Channel '${error.channelName}' is closed`;
    case 'cancelled':
      return `Cancelled${error.reason ? `: ${error.reason}` : ''}`;
    case 'budget_exceeded':
      return `Budget exceeded: ${error.field} limit ${error.limit}, actual ${error.actual}`;
    case 'steering_denied':
      return `Steering denied${error.guidance ? `: ${error.guidance}` : ''}`;
    case 'item_schema_mismatch':
      return error.itemType
        ? `Item type '${error.itemType}' did not match any registered item extension schema.`
        : `Item did not match any registered ${error.category} extension schema.`;
    case 'connection_unavailable':
      return `Connection '${error.connection}' is unavailable: ${error.reason}`;
    case 'connection_failed':
      return `Connection '${error.connection}' failed '${error.op}' (${error.error.code}): ${error.error.message}`;
    case 'connection_ref_invalid':
      return `Connection '${error.connection}' refused a ref: ${error.reason}`;
    case 'connection_secret_refused':
      return `Connection '${error.connection}' refused a secret in '${error.op}': secrets fill only sensitive fields, never from the model`;
    case 'connection_input_required':
      return `Connection '${error.connection}' needs input nobody could give: ${error.request.message}`;
    case 'connection_resume_refused':
      return `Connection '${error.connection}' cannot be resumed: ${error.reason}`;
    case 'connection_outcome_unknown':
      return `Connection '${error.connection}' has an unknown outcome for '${error.op}' (key '${error.key}').`;
    case 'subprocess_outcome_unknown':
      return `Subprocess step '${error.stepId}' has an unknown outcome${error.cause ? `: ${error.cause.message}` : '.'}`;
    case 'acp_outcome_unknown':
      return `ACP step '${error.stepId}' has an unknown outcome${error.sessionId ? ` for session '${error.sessionId}'` : ''}${error.cause ? `: ${error.cause.message}` : '.'}`;
    case 'acp_link_lost':
      return `ACP step '${error.stepId}' lost its link: ${error.cause.message}`;
    case 'lease_lost':
      return `Execution '${error.executionId}' lost its lease at term ${error.term}: ${error.reason}`;
    case 'ledger_write_failed':
      return `Execution '${error.executionId}' could not record '${error.path}': ${error.cause.message}`;
    case 'turn_stuck':
      return `Execution '${error.executionId}' is stuck: step '${error.path}' had a lasting effect under version '${error.from}' and no longer matches under '${error.to}'`;
    case 'decision_refused':
      return `Thread '${error.threadId}' refused the decision '${error.action}': ${error.reason}`;
    case 'hold_refused':
      return `Held call '${error.callId}' refused the answer: ${error.reason}`;
    case 'verify_act_failed':
      return `Verify '${error.stepId}' act failed: ${error.cause.message}`;
    default: {
      const _exhaustive: never = error;
      void _exhaustive;
      return 'NoeticError: unknown kind';
    }
  }
}
