import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ZodError } from 'zod';

/** @public Discriminated union of all structured error kinds raised by the runtime. */
export type NoeticError =
  | {
      kind: 'step_failed';
      stepId: string;
      cause: Error;
      retriesExhausted: boolean;
    }
  | {
      kind: 'model_refused';
      stepId: string;
      refusal: string;
    }
  | {
      kind: 'model_parse_error';
      stepId: string;
      raw: string;
      schema: StandardSchemaV1;
      /** Real `ZodError` for Zod schemas; synthetic `custom` issues adapted from the vendor's Standard Schema issues otherwise. */
      zodError: ZodError;
    }
  | {
      kind: 'model_rate_limit';
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
      /**
       * A spawn's child succeeded but a context layer's `onReturn` hook (for
       * example a summarizer) failed. The runtime does not throw this: the
       * spawn returns `childOutput` and reports this error as a layer
       * diagnostic and a span event, so the child's work is never discarded.
       */
      kind: 'spawn_summary_failed';
      stepId: string;
      childOutput: unknown;
      summaryCause: Error;
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
      /**
       * Raised by `ItemSchemaRegistry` when an item fails extension-schema
       * validation: either a category item (e.g. a tool result) matches none
       * of the schemas registered for its category, or — under
       * `strictUnknownExtensions` — an unknown item type matches no
       * registered extension schema. `itemType` is set for the
       * unknown-item-type case.
       */
      kind: 'item_schema_mismatch';
      category: 'items' | 'developerMessages' | 'toolCalls' | 'toolResults';
      itemType?: string;
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
    };
