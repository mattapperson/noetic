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
    case 'llm_refused':
      return `LLM refused at step '${error.stepId}': ${error.refusal}`;
    case 'llm_parse_error':
      return `LLM parse error at step '${error.stepId}': failed to parse output`;
    case 'llm_rate_limit':
      return `LLM rate limited at step '${error.stepId}'${error.retryAfter ? ` (retry after ${error.retryAfter}ms)` : ''}`;
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
    default:
      return `OrchidError: ${(error as any).kind}`;
  }
}
