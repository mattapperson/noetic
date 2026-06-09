import type {
  ProcessSubprocessRequest,
  SerializedError,
  StepSubprocessRequest,
  SubprocessHandleMetadata,
  SubprocessRequest,
} from '@noetic-tools/types';

//#region Time

export function nowIso(): string {
  return new Date().toISOString();
}

//#endregion

//#region Type guards

export function isStepRequest(request: SubprocessRequest): request is StepSubprocessRequest {
  return request.kind === 'step';
}

export function isProcessRequest(request: SubprocessRequest): request is ProcessSubprocessRequest {
  return request.kind !== 'step';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

//#endregion

//#region Error serialisation

/** Convert a thrown value into a `SerializedError`. `NoeticErrorImpl`
 *  instances (and anything exposing `noeticError`) retain their structured
 *  payload so consumers can rehydrate typed kinds without a brittle message
 *  regex. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const payload: SerializedError = {
      message: err.message,
      name: err.name,
      stack: err.stack,
    };
    if (isRecord(err) && 'noeticError' in err) {
      payload.noeticError = err.noeticError;
    }
    return payload;
  }
  return {
    message: typeof err === 'string' ? err : String(err),
  };
}

//#endregion

//#region Metadata builders

export function buildProcessMetadata(request: ProcessSubprocessRequest): SubprocessHandleMetadata {
  return {
    ...(request.metadata ?? {}),
    runtime: 'in-memory',
    command: request.command,
    args: request.args ?? [],
    cwd: request.cwd,
  };
}

export function buildStepMetadata(request: StepSubprocessRequest): SubprocessHandleMetadata {
  return {
    ...(request.metadata ?? {}),
    runtime: 'in-memory',
    kind: 'step',
    stepId: request.stepId,
    executionId: request.executionId,
  };
}

//#endregion
