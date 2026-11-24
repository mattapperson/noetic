/**
 * Reads a `DecisionItem` a host passed to `execute()`: what it asks for, or why
 * it cannot be taken. Reading changes nothing, so a list of decisions is read
 * whole before any is acted on.
 */

import type {
  DecisionItem,
  ExecutionScope,
  HeldResolution,
  SessionScope,
} from '@noetic-tools/types';
import { NoeticErrorImpl } from '@noetic-tools/types';

//#region Types

/** A decision, read: the stuck turn to settle, or the held call to answer. */
export type ReadDecision =
  | {
      readonly threadId: string;
      readonly settle: 'continue' | 'restart' | 'abandon';
    }
  | {
      readonly scope: SessionScope | ExecutionScope;
      readonly answer: HeldResolution & {
        readonly callId: string;
        readonly argsHash?: string;
      };
    };

/** A decision as a caller without types may have built it: any field, or none. */
interface LooseDecision {
  readonly callId?: string;
  readonly executionId?: string;
  readonly argsHash?: string;
  readonly action?: string;
  readonly guidance?: string;
  readonly output?: unknown;
}

//#endregion

//#region Helpers

/** True for a value storage can hold and hand back: JSON, with nothing dropped. */
function isJsonValue(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function isSettling(action: string | undefined): action is 'continue' | 'restart' | 'abandon' {
  return action === 'continue' || action === 'restart' || action === 'abandon';
}

function isAnswering(action: string | undefined): action is 'allow' | 'deny' | 'guide' {
  return action === 'allow' || action === 'deny' || action === 'guide';
}

//#endregion

//#region Public API

/**
 * @throws NoeticError `decision_refused` when the decision carries both an action
 *   and an output, or an action of the wrong kind for a decision with, or without,
 *   a `callId`; `hold_refused` when its `output` is not a JSON value.
 */
export function readDecision(threadId: string, decision: DecisionItem): ReadDecision {
  const loose: LooseDecision = decision;
  const { callId, action } = loose;
  const hasOutput = 'output' in loose;
  const refuse = (reason: string): never => {
    throw new NoeticErrorImpl({
      kind: 'decision_refused',
      threadId,
      action: action === undefined ? 'output' : String(action),
      reason,
    });
  };
  if (hasOutput && action !== undefined) {
    return refuse('it carries both an action and an output: give one');
  }
  if (callId === undefined) {
    if (isSettling(action)) {
      return {
        threadId,
        settle: action,
      };
    }
    return refuse('it answers a held call: give its callId');
  }
  const scope =
    loose.executionId === undefined
      ? {
          threadId,
        }
      : {
          executionId: loose.executionId,
        };
  const target = {
    callId,
    argsHash: loose.argsHash,
  };
  if (hasOutput) {
    if (!isJsonValue(loose.output)) {
      throw new NoeticErrorImpl({
        kind: 'hold_refused',
        callId,
        reason: 'its output is not a JSON value, so it cannot be recorded',
      });
    }
    return {
      scope,
      answer: {
        ...target,
        output: loose.output,
      },
    };
  }
  if (!isAnswering(action)) {
    return refuse(
      isSettling(action)
        ? 'it settles a stuck turn: it takes no callId'
        : 'a decision for a held call is allow, deny or guide, or carries an output',
    );
  }
  return {
    scope,
    answer: {
      ...target,
      action,
      ...(loose.guidance === undefined
        ? {}
        : {
            guidance: loose.guidance,
          }),
    },
  };
}

//#endregion
