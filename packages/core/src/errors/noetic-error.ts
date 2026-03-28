import type { NoeticError } from '../types/error';

/**
 * Runtime error thrown during step execution (LLM failures, fork failures, budget exceeded, etc.).
 *
 * @public
 */
export class NoeticErrorImpl extends Error {
  readonly noeticError: NoeticError;

  constructor(error: NoeticError) {
    super(formatMessage(error));
    this.name = 'NoeticError';
    this.noeticError = error;
  }
}

/**
 * Type guard for `NoeticErrorImpl`.
 *
 * @public
 * @param e - Value to check.
 * @returns `true` if `e` is a `NoeticErrorImpl`.
 */
export function isNoeticError(e: unknown): e is NoeticErrorImpl {
  return e instanceof NoeticErrorImpl;
}

function formatMessage(error: NoeticError): string {
  switch (error.kind) {
    case 'step_failed':
      return `Step '${error.stepId}' failed: ${error.cause.message}`;
    case 'llm_refused':
      return `LLM refused at step '${error.stepId}': ${error.refusal}`;
    case 'llm_parse_error':
      return `LLM parse error at step '${error.stepId}': failed to parse output`;
    case 'llm_rate_limit':
      return `LLM rate limited at step '${error.stepId}'${error.retryAfter ? ` (retry after ${error.retryAfter}ms)` : ''}`;
    case 'fork_partial':
      return `Fork '${error.stepId}' partial failure: ${error.succeeded.length} succeeded, ${error.failed.length} failed`;
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
    default: {
      const _exhaustive: never = error;
      void _exhaustive;
      return 'NoeticError: unknown kind';
    }
  }
}
