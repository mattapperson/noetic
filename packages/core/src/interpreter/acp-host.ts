import type {
  AcpClientHost,
  AcpCreateElicitationRequest,
  AcpPermissionOutcome,
  AcpPermissionSteerer,
  Context,
  ContextData,
  ContextLayer,
  StepAcpAgent,
} from '@noetic-tools/types';
import { SteeringAction } from '@noetic-tools/types';
import { awaitApproval } from '../runtime/tool-approval';
import type { AcpEventBridge } from './acp-events';
import type { QuestionAsker } from './acp-questions';
import { AcpToolRunner } from './acp-tools';
import { abortSignalOf } from './typeguards';

//#region Permissions

/**
 * Bridge the agent's permission requests into the steering pipeline.
 *
 * Steering is a **veto** tier: `beforeToolCall` returns `allow` both when a rule
 * explicitly permits the call *and* when no steering hook exists at all, so
 * treating `allow` as decisive would silently grant every permission. Only a
 * non-allow decision is acted on; anything else abstains and the next tier
 * (the step's handler, then the policy default) decides.
 */
function buildSteerer(
  ctx: Context<ContextData>,
  layers: ContextLayer[] | undefined,
): AcpPermissionSteerer | undefined {
  if (!layers || layers.length === 0) {
    return undefined;
  }
  return async (request): Promise<AcpPermissionOutcome | undefined> => {
    const decision = await ctx.harness.beforeToolCall(
      layers,
      request.toolCall.title ?? request.toolCall.toolCallId,
      request.toolCall.rawInput,
      ctx,
      request.toolCall.toolCallId,
    );
    if (decision.action === SteeringAction.Allow) {
      return undefined;
    }
    return {
      decision: 'deny',
      reason: decision.guidance ?? `steering ${decision.action}`,
    };
  };
}

/**
 * The last tier of a permission request: the harness's approval seam (spec 08
 * § Held tool calls). The agent's process is waiting on the answer and its session
 * would not survive the turn stopping, so the turn stays live while the request is
 * held.
 */
function buildApprover(
  ctx: Context<ContextData>,
  events: AcpEventBridge,
): AcpPermissionSteerer | undefined {
  // A harness with no approval seam has none to give.
  if (!ctx.harness.approve) {
    return undefined;
  }
  return async (request): Promise<AcpPermissionOutcome | undefined> => {
    // `harness.approve()` itself, plus who asks: a subagent's request is held
    // as the run's, named as its nested agent's.
    const { decision } = await awaitApproval({
      harness: ctx.harness,
      toolName: request.toolCall.title ?? request.toolCall.toolCallId,
      toolArgs: request.toolCall.rawInput,
      callId: request.toolCall.toolCallId,
      ctx,
      park: false,
      scope: events.scopeFor(request.sessionId),
    });
    if (decision.action === SteeringAction.Allow) {
      return {
        decision: 'allow',
      };
    }
    return {
      decision: 'deny',
      reason: decision.guidance ?? `approval ${decision.action}`,
    };
  };
}

//#endregion

//#region Host binding

export interface HostBindingOptions<TContext, I, O> {
  step: StepAcpAgent<TContext, I, O>;
  ctx: Context<ContextData>;
  /** The step's questions to a person, one asker for the whole step. */
  questions: QuestionAsker;
  /** `agentId` of the adapter taking the turn, surfaced to permission handlers. */
  agentId: string;
  /** Sink for the agent's `fs/*` and `terminal/*` calls. */
  onActivity: NonNullable<AcpClientHost['onClientActivity']>;
  layers?: ContextLayer[];
  onUpdate: AcpClientHost['onSessionUpdate'];
  /** A subagent's traffic: a nested agent of this turn (spec 08 § Nested agents). */
  onChildUpdate: NonNullable<AcpClientHost['onChildUpdate']>;
  /** The step's tools, served to the agent; `undefined` when it gave none. */
  tools?: AcpToolRunner;
  events: AcpEventBridge;
  /** Fail the turn when the tool pipeline itself throws. */
  failTurn: (error: unknown) => void;
}

/**
 * Point an existing host at the step that is about to take a turn.
 *
 * A connection outlives the step that opened it, so everything per-turn —
 * permissions, steering, the async handler, the event sink — must be rebound
 * before each turn. Without this, a session shared by several steps answers
 * every later step with the FIRST step's policy and streams its output to the
 * first step's (already finalized) event bridge.
 */
export function bindHostToStep<TContext, I, O>(
  host: AcpClientHost,
  opts: HostBindingOptions<TContext, I, O>,
): void {
  host.permissions = opts.step.permissions;
  host.steerPermission = buildSteerer(opts.ctx, opts.layers);
  host.approvePermission = buildApprover(opts.ctx, opts.events);
  // Bind the executing context into the handler so the protocol client never
  // has to know about `Context` — it just asks a question and gets an answer.
  const handler = opts.step.onPermissionRequest;
  host.onPermissionRequest = handler
    ? (request) =>
        handler(request, opts.ctx, {
          agentId: opts.agentId,
          stepId: opts.step.id,
        })
    : undefined;
  // An agent's question is a question for a person: held like any other (spec 27
  // § Questions the agent asks), answered by whoever answers held calls.
  host.onElicitation = (request, info) =>
    opts.questions.ask(request, info, opts.events.scopeFor(sessionOfQuestion(request)));
  host.onSessionUpdate = opts.onUpdate;
  host.onChildUpdate = opts.onChildUpdate;
  host.onClientActivity = opts.onActivity;
  // A step that gives no tools gets none, even on a session another step
  // opened with tools. The session's runner stays listed, so the agent's
  // permission requests are still recognized, but its calls answer as unknown
  // tools.
  if (!opts.tools) {
    if (host.tools instanceof AcpToolRunner) {
      host.tools.unbind();
    }
    return;
  }
  host.tools = opts.tools;
  opts.tools.bind({
    stepId: opts.step.id,
    ctx: opts.ctx,
    layers: opts.layers,
    events: opts.events,
    fail: opts.failTurn,
  });
}

export function buildHost<TContext, I, O>(
  opts: HostBindingOptions<TContext, I, O> & {
    cwd: string;
  },
): AcpClientHost {
  const host: AcpClientHost = {
    cwd: opts.cwd,
    fs: opts.ctx.fs,
    shell: opts.ctx.shell,
    threadId: opts.ctx.threadId,
    signal: abortSignalOf(opts.ctx),
    // Connection-level: ACP negotiates the capability set once, in `initialize`.
    capabilities: opts.step.clientCapabilities,
    onSessionUpdate: opts.onUpdate,
    onClientActivity: opts.onActivity,
  };
  bindHostToStep(host, opts);
  return host;
}

/** The session a question names, when it names one (form and URL questions do). */
function sessionOfQuestion(request: AcpCreateElicitationRequest): string | undefined {
  const sessionId = Reflect.get(request, 'sessionId');
  return typeof sessionId === 'string' ? sessionId : undefined;
}

//#endregion
