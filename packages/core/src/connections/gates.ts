/**
 * The gates (spec 35 § Gates). Every connection call — from the model, a
 * step, or a document — passes the same gates, in order:
 *
 * 1. The operation exists on the connection, and for steps and documents is
 *    declared by the manifest or handle.
 * 2. Its arguments match the operation's schema. Nothing is defaulted.
 * 3. Its refs were issued by this harness to this thread, for this connection.
 * 4. The connection's `policy`; `guarded` operations need approval unless the
 *    policy allows them.
 * 5. `beforeToolCall` layers and the harness approver, as for any tool.
 * 6. Secrets are filled in, and the call is sent.
 *
 * A refusal throws `steering_denied` (a step fails with it; a model tool
 * returns it as a tool error). A server that refuses with `guarded` is asked
 * for approval and retried with `_meta["tools.noetic/confirmed"]`. Long
 * operations are waited on, with progress reported as `connection_task`.
 */

import type {
  ArtifactStore,
  CallOutcome,
  Connection,
  ConnectionOperationInfo,
  ConnectionPolicy,
  ConnectionTaskStatus,
  Context,
  SecretResolver,
  SteeringDecision,
} from '@noetic-tools/types';
import { SteeringAction } from '@noetic-tools/types';
import { attachBlobs, checkBlobs } from './blobs';
import { deniedError, failedError, inputRequiredError } from './errors';
import { validateJsonSchema } from './json-schema';
import { evaluatePolicy } from './policy';
import type { RefScope, RefSealer } from './refs';
import type { ConnectionCaller, GatedCallOptions } from './registry-types';
import type { SecretScrubber } from './secrets';
import { checkSecrets, fillSecrets } from './secrets';

//#region Types

/** A call as the harness's own gates (layers, approver) see it. */
export interface GateRequest {
  readonly connection: string;
  readonly op: string;
  /** The arguments with secrets still unfilled. */
  readonly args: unknown;
  readonly caller: ConnectionCaller;
  /** The name a tool pipeline would know the call by: `<connection>_<op>`. */
  readonly toolName: string;
  readonly callId?: string;
  readonly ctx?: Context;
  /** Why approval is being asked: a policy or profile flag, or a server's `guarded` refusal. */
  readonly reason?: 'policy' | 'guarded';
}

/** The harness hooks gate 5 runs, and who answers long operations' questions. */
export interface GateHooks {
  /** `beforeToolCall` layers. Skipped for model calls, whose tool pipeline already ran them. */
  beforeCall?(request: GateRequest): Promise<SteeringDecision>;
  /** The harness approver. Without one, calls that need approval are refused. */
  approve?(request: GateRequest): Promise<SteeringDecision>;
  /** Answers an `input_required` question; `undefined` when nobody can. */
  answerInput?(
    request: GateRequest & {
      readonly status: ConnectionTaskStatus;
    },
  ): Promise<
    | {
        readonly answer: unknown;
      }
    | undefined
  >;
}

/** Everything one gated call runs against. */
export interface GateContext {
  readonly name: string;
  readonly connection: Connection;
  readonly policy?: ConnectionPolicy;
  readonly executionId: string;
  readonly refScope: RefScope;
  readonly refs: RefSealer;
  readonly scrubber: SecretScrubber;
  readonly secrets?: SecretResolver;
  readonly artifacts: ArtifactStore;
  readonly hooks: GateHooks;
  /** Progress of a long operation (the registry emits `connection_task`). */
  readonly onTask?: (op: string, status: ConnectionTaskStatus, stepId?: string) => void;
  /** An operation with effects ran (connection views re-read `'effect'` reads). */
  readonly onEffect?: () => void;
}

//#endregion

//#region Helpers

function refuse(decision: SteeringDecision, fallback: string): never {
  throw deniedError(decision.guidance ?? fallback);
}

function toolNameOf(connection: string, op: string): string {
  return `${connection}_${op.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function operationInfo(
  gc: GateContext,
  op: string,
  opts: GatedCallOptions,
): ConnectionOperationInfo {
  const info = gc.connection.manifest.operations[op];
  if (!info) {
    throw deniedError(`operation '${op}' is not offered by connection '${gc.name}'`);
  }
  if (opts.declaredOps && !opts.declaredOps.includes(op)) {
    throw deniedError(
      `operation '${op}' on connection '${gc.name}' is not declared by the handle or manifest`,
    );
  }
  return info;
}

function checkArguments(info: ConnectionOperationInfo, args: unknown, connection: string): void {
  const errors = validateJsonSchema(info.inputSchema, args);
  if (errors.length === 0) {
    return;
  }
  throw deniedError(
    `arguments for '${info.name}' on connection '${connection}' do not match its schema: ${errors.join('; ')}`,
  );
}

async function approve(gc: GateContext, request: GateRequest): Promise<void> {
  const approver = gc.hooks.approve;
  if (!approver) {
    throw deniedError(
      `operation '${request.op}' on connection '${gc.name}' needs approval, but the harness has no approver`,
    );
  }
  const decision = await approver(request);
  if (decision.action !== SteeringAction.Allow) {
    refuse(decision, `operation '${request.op}' on connection '${gc.name}' was not approved`);
  }
}

async function runHarnessGates(
  gc: GateContext,
  request: GateRequest,
  needsApproval: boolean,
): Promise<void> {
  if (request.caller !== 'model' && gc.hooks.beforeCall) {
    const decision = await gc.hooks.beforeCall(request);
    if (decision.action !== SteeringAction.Allow) {
      refuse(decision, `operation '${request.op}' was refused by a steering layer`);
    }
  }
  if (needsApproval) {
    await approve(gc, request);
  }
}

/** Waits for a long operation, answering questions through the hooks when someone can. */
async function awaitTask(
  gc: GateContext,
  request: GateRequest & {
    readonly taskId: string;
    readonly signal: AbortSignal;
    readonly stepId?: string;
    readonly onTask?: (status: ConnectionTaskStatus) => void;
  },
): Promise<CallOutcome> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', onParentAbort, {
    once: true,
  });
  let unanswered: ConnectionTaskStatus | undefined;
  const answering = new Set<string>();
  const answer = async (status: ConnectionTaskStatus): Promise<void> => {
    const question = status.request;
    if (!question || answering.has(question.id)) {
      return;
    }
    answering.add(question.id);
    const reply = await gc.hooks.answerInput?.({
      ...request,
      status,
    });
    if (!reply) {
      unanswered = status;
      controller.abort();
      return;
    }
    await gc.connection.tasks.respond(request.taskId, question.id, reply.answer);
  };
  try {
    return await gc.connection.tasks.result(request.taskId, {
      signal: controller.signal,
      onProgress: (status) => {
        // The registry emits `connection_task` (to the caller's run when it has a ctx).
        gc.onTask?.(request.op, status, request.stepId);
        request.onTask?.(status);
        if (status.state === 'input_required') {
          void answer(status);
        }
      },
    });
  } catch (e) {
    if (unanswered?.request) {
      await gc.connection.tasks.cancel(request.taskId).catch(() => undefined);
      throw inputRequiredError(gc.name, unanswered.request);
    }
    if (request.signal.aborted) {
      await gc.connection.tasks.cancel(request.taskId).catch(() => undefined);
    }
    throw e;
  } finally {
    request.signal.removeEventListener('abort', onParentAbort);
  }
}

/** Sends the call, retrying once with `confirmed` after a server's `guarded` refusal is approved. */
async function send(
  gc: GateContext,
  request: GateRequest & {
    readonly filled: unknown;
    readonly opts: GatedCallOptions;
    readonly confirmed: boolean;
    /** The policy's `allow` names the operation: a `guarded` refusal is confirmed without asking. */
    readonly policyAllows: boolean;
  },
): Promise<CallOutcome> {
  const result = await gc.connection.call(request.op, request.filled, {
    signal: request.opts.signal,
    idempotencyKey: request.opts.idempotencyKey,
    ...(request.confirmed
      ? {
          confirmed: true,
        }
      : {}),
  });
  if (result.status === 'error' && result.error.code === 'guarded' && !request.confirmed) {
    if (!request.policyAllows) {
      await approve(gc, {
        ...request,
        reason: 'guarded',
      });
    }
    return send(gc, {
      ...request,
      confirmed: true,
    });
  }
  if (result.status !== 'task') {
    return result;
  }
  return awaitTask(gc, {
    ...request,
    taskId: result.taskId,
    signal: request.opts.signal,
    stepId: request.opts.stepId,
    onTask: request.opts.onTask,
  });
}

/** Scrubs secrets, seals refs and links blobs in a value coming in from a connection. */
export async function admitIncoming(
  gc: Pick<GateContext, 'scrubber' | 'refs' | 'refScope' | 'artifacts' | 'executionId' | 'name'>,
  value: unknown,
  stepPath?: string,
): Promise<unknown> {
  const scrubbed = gc.scrubber.scrub(value);
  const sealed = await gc.refs.sealAll(scrubbed, gc.refScope);
  await attachBlobs(sealed, gc.artifacts, {
    executionId: gc.executionId,
    source: gc.name,
    stepPath,
  });
  return sealed;
}

/** Turns a call's outcome into its output: errors throw, effects are counted, the rest is admitted. */
async function outputOf(
  gc: GateContext,
  result: {
    readonly op: string;
    readonly info: ConnectionOperationInfo | undefined;
    readonly outcome: CallOutcome;
    readonly stepId: string | undefined;
  },
): Promise<unknown> {
  const { op, info, outcome, stepId } = result;
  if (outcome.status === 'error') {
    throw failedError(gc.name, op, gc.scrubber.scrub(outcome.error));
  }
  if (info?.effects || info?.once) {
    gc.onEffect?.();
  }
  return admitIncoming(gc, outcome.output, stepId);
}

//#endregion

//#region Public API

/**
 * Waits on a long operation a previous attempt started, instead of sending the
 * operation again (spec 35 § Durability: "waiting on the same task"). Its
 * outcome is handled exactly as `gatedCall`'s.
 *
 * @throws NoeticErrorImpl `connection_failed` or `connection_input_required`.
 */
export async function gatedAwaitTask(
  gc: GateContext,
  task: {
    readonly op: string;
    readonly taskId: string;
    readonly opts: GatedCallOptions;
  },
): Promise<unknown> {
  const { op, taskId, opts } = task;
  const outcome = await awaitTask(gc, {
    connection: gc.name,
    op,
    args: {},
    caller: opts.caller,
    toolName: toolNameOf(gc.name, op),
    callId: opts.toolCallId ?? opts.stepId,
    ctx: opts.ctx,
    taskId,
    signal: opts.signal,
    stepId: opts.stepId,
    onTask: opts.onTask,
  });
  return outputOf(gc, {
    op,
    info: gc.connection.manifest.operations[op],
    outcome,
    stepId: opts.stepId,
  });
}

/**
 * Runs one call through gates 1–6 and returns its output.
 *
 * @throws NoeticErrorImpl `steering_denied` when a gate refuses,
 * `connection_ref_invalid`, `connection_secret_refused`, `connection_failed`
 * or `connection_input_required`.
 */
export async function gatedCall(
  gc: GateContext,
  call: {
    readonly op: string;
    readonly args: unknown;
    readonly opts: GatedCallOptions & {
      readonly ctx?: Context;
    };
  },
): Promise<unknown> {
  const { op, args, opts } = call;
  const info = operationInfo(gc, op, opts);
  // Secrets first: one in a field that is not `sensitive` is refused as such
  // (`connection_secret_refused`), not as a schema mismatch.
  checkSecrets(args, {
    connection: gc.name,
    op,
    caller: opts.caller,
    inputSchema: info.inputSchema,
    ...(opts.caller === 'document'
      ? {
          allowedSecrets: opts.documentSecrets ?? [],
        }
      : {}),
  });
  checkArguments(info, args, gc.name);
  await checkBlobs(args, gc.artifacts, gc.name);
  await gc.refs.checkAll(args, gc.refScope);
  const verdict = evaluatePolicy(gc.policy, op, info.guarded === true);
  if (verdict.kind === 'deny') {
    throw deniedError(verdict.reason);
  }
  const request: GateRequest = {
    connection: gc.name,
    op,
    args,
    caller: opts.caller,
    toolName: toolNameOf(gc.name, op),
    callId: opts.toolCallId ?? opts.stepId,
    ctx: opts.ctx,
    reason: verdict.needsApproval ? 'policy' : undefined,
  };
  await runHarnessGates(gc, request, verdict.needsApproval);
  const filled = await fillSecrets(args, {
    resolver: gc.secrets,
    scrubber: gc.scrubber,
    signal: opts.signal,
  });
  const outcome = await send(gc, {
    ...request,
    filled,
    opts,
    confirmed: verdict.needsApproval,
    policyAllows: verdict.explicitlyAllowed,
  });
  return outputOf(gc, {
    op,
    info,
    outcome,
    stepId: opts.stepId,
  });
}

//#endregion
