import type { ZodError, ZodType } from 'zod';

/** @public Discriminated union of all structured error kinds raised by the runtime. */
export type NoeticError =
  | {
      kind: 'step_failed';
      stepId: string;
      cause: Error;
      retriesExhausted: boolean;
    }
  | {
      kind: 'llm_refused';
      stepId: string;
      refusal: string;
    }
  | {
      kind: 'llm_parse_error';
      stepId: string;
      raw: string;
      schema: ZodType;
      zodError: ZodError;
    }
  | {
      kind: 'llm_rate_limit';
      stepId: string;
      retryAfter?: number;
    }
  | {
      kind: 'fork_partial';
      stepId: string;
      succeeded: Array<{
        stepId: string;
        value: unknown;
      }>;
      failed: Array<{
        stepId: string;
        error: NoeticError;
      }>;
    }
  | {
      kind: 'channel_timeout';
      channelName: string;
      timeout: number;
    }
  | {
      kind: 'channel_closed';
      channelName: string;
    }
  | {
      kind: 'cancelled';
      reason?: string;
    }
  | {
      kind: 'budget_exceeded';
      field: 'cost' | 'steps' | 'duration';
      limit: number;
      actual: number;
    }
  | {
      kind: 'steering_denied';
      guidance?: string;
    }
  | {
      /**
       * Raised by `DetachedHandle.await()` when the adapter persistently
       * returns `null` for a handle that was previously spawned — the
       * handle has been evicted from the adapter's registry, either by
       * a restart-after-stop-without-restore flow or by a storage
       * inconsistency. This guards against an otherwise-infinite poll
       * loop that would hold the promise open forever. A short grace
       * period tolerates transient nulls (e.g. the in-memory adapter
       * briefly returning null between spawn and first microtask yield).
       */
      kind: 'handle_evicted';
      handleId: string;
      stepId: string;
      gracePeriodMs: number;
    };
