import type { ZodError, ZodType } from 'zod';

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
    };
