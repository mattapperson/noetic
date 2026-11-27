/**
 * ACP step handler: drives an external coding agent over the Agent Client
 * Protocol for one prompt turn and folds its output back into the Noetic
 * execution context — the ACP analogue of `executeCallModel`.
 *
 * Core reaches the agent only through the `@noetic-tools/types` contract, so no
 * protocol library or agent SDK enters its dependency graph.
 */

import type {
  AcpAgent,
  AcpClientActivity,
  AcpContentBlock,
  Context,
  ContextData,
  ContextLayer,
  Item,
  StepAcpAgent,
} from '@noetic-tools/types';
import {
  createMessage,
  frameworkCast,
  isAcpConnectError,
  isNoeticError,
  NoeticConfigError,
  NoeticErrorImpl,
  SteeringAction,
} from '@noetic-tools/types';
import { assertAgentTakesTools } from '../builders/acp-agent-checks';
import { acpAdapterNames } from './acp-adapters';
import { AcpEventBridge } from './acp-events';
import { withHistoryPrompt } from './acp-history';
import type { HostBindingOptions } from './acp-host';
import { bindHostToStep, buildHost } from './acp-host';
import { renderLayerContext } from './acp-layers';
import type { QuestionAsker } from './acp-questions';
import { questionAsker } from './acp-questions';
import type { AcpSessionRecords } from './acp-resume';
import { ACP_RESUME_NOTICE, acpRecovery, wasCut } from './acp-resume';
import type { SessionResolution } from './acp-session';
import {
  applySessionSelection,
  assertReuseIsKeptAlive,
  detachSession,
  finalizeSession,
  openSession,
  resolveSessionSettings,
} from './acp-session';
import type { AcpToolRunner } from './acp-tools';
import { resolveAcpTools } from './acp-tools';
import type { TurnError } from './acp-turn';
import {
  applyTurnResult,
  assertTurnSucceeded,
  buildContent,
  currentModel,
  publishStepMeta,
  runTurn,
  stepFailure,
  stepOutput,
  toLlmResponse,
} from './acp-turn';
import { MAX_STEERING_RETRIES, resolveLazy } from './action-tools';
import { appendUserInput } from './context-assembly';
import type { StepKindScope } from './step-kind-dispatch';

async function resolveAgent<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  ctx: Context<TContext>,
): Promise<AcpAgent> {
  const resolved = await resolveLazy(step.agent, ctx);
  if (!resolved) {
    throw new NoeticConfigError({
      code: 'MISSING_ACP_AGENT',
      message: `step.acpAgent(${JSON.stringify(step.id)}) resolved no agent adapter.`,
      hint: 'Pass an agent factory result, e.g. agent: claudeCode() from @noetic-tools/acp.',
    });
  }
  return resolved;
}

/**
 * The tools the agent is served. No `tools` offers every tool the run has,
 * as on `callModel`, and an agent that cannot take tools then simply gets
 * none; tools given explicitly to such an agent are a configuration error.
 */
async function resolveServedTools<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  ctx: Context<TContext>,
  layers: ContextLayer[] | undefined,
  agent: AcpAgent,
): Promise<AcpToolRunner | undefined> {
  const given = gives(step.tools);
  if (given) {
    assertAgentTakesTools(step.id, agent);
  }
  const tools = await resolveAcpTools(step, ctx, layers);
  if (given || agent.refusesTools === undefined) {
    return tools;
  }
  return undefined;
}

function gives(setting: unknown): boolean {
  return typeof setting === 'function' || (Array.isArray(setting) && setting.length > 0);
}

export async function executeAcpAgent<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  input: I,
  scope: StepKindScope<TContext>,
): Promise<O> {
  const {
    stepCtx: ctx,
    baseCtx: { layers },
  } = scope;
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);
  assertReuseIsKeptAlive(step);
  const agent = await resolveAgent(step, ctx);
  const questions = questionAsker({
    ctx: baseCtx,
    agentId: agent.agentId,
    stepId: step.id,
  });
  // A question's answer is kept until the step ends, so a host that died after
  // taking it and before the agent got it is not asked again (spec 27
  // § Questions the agent asks). A step cut off with its host never gets here.
  try {
    const output = await runAcpStep({
      step,
      input,
      ctx,
      layers,
      agent,
      questions,
      scope,
    });
    await questions.release().catch(() => undefined);
    return output;
  } catch (error) {
    // The keeper can ask the next attachment the same question.
    if (
      !wasCut(baseCtx) &&
      (!isNoeticError(error) ||
        ![
          'acp_link_lost',
          'lease_lost',
        ].includes(error.noeticError.kind))
    ) {
      await questions.release().catch(() => undefined);
    }
    throw error;
  }
}

async function runAcpStep<TContext, I, O>(params: {
  step: StepAcpAgent<TContext, I, O>;
  input: I;
  ctx: Context<TContext>;
  layers: ContextLayer[] | undefined;
  agent: AcpAgent;
  questions: QuestionAsker;
  scope: StepKindScope<TContext>;
}): Promise<O> {
  const { step, input, ctx, layers, agent, questions, scope } = params;
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);
  const resolvedPrompt = await resolveLazy(step.prompt, ctx);
  const blocks = await resolveLazy(step.content, ctx);
  const promptText =
    resolvedPrompt && resolvedPrompt.length > 0
      ? resolvedPrompt
      : typeof input === 'string'
        ? input
        : '';
  if (promptText.trim() === '' && (!blocks || blocks.length === 0)) {
    throw new NoeticConfigError({
      code: 'MISSING_PROMPT',
      message: `step.acpAgent(${JSON.stringify(step.id)}) resolved an empty prompt.`,
      hint: 'Provide a non-empty `prompt` or `content`, or pass a string input to the step.',
    });
  }

  const adapters = acpAdapterNames(step, agent, baseCtx);
  const cwd = (await resolveLazy(step.cwd, ctx)) ?? baseCtx.cwdState.cwd;
  const settings = await resolveSessionSettings(step, ctx);
  const tools = await resolveServedTools(step, ctx, layers, agent);

  // Capture the conversation so far BEFORE appending this turn's prompt, so a
  // fresh session can be seeded with it and the agent is not left guessing at
  // what earlier steps established.
  const priorHistory: Item[] = [
    ...baseCtx.itemLog.items,
  ];
  // Through the layers' append pipeline, as `callModel` adds its input.
  const rerenderRequests = await appendUserInput({
    ctx: baseCtx,
    layers,
    input: promptText,
  });

  const { sessions, recorded, ledger, position, bridgePath, promptHash } = await acpRecovery({
    ctx: baseCtx,
    stepId: step.id,
    agentId: agent.agentId,
    ledgerKey: scope.ledgerKey,
    subprocess: adapters.subprocess,
    prompt: {
      text: promptText,
      blocks,
    },
  });
  const resumeId = recorded?.sessionId;
  const reattach = recorded?.reattach;
  const fingerprint = recorded?.fingerprint;
  // `session/load` replays the session's conversation as updates. They are the
  // agent's history, not this turn's work: they reach raw-event consumers
  // marked `replay: true`, and never the text, reasoning or item streams.
  let reloading = false;

  const bridge = new AcpEventBridge(step, baseCtx);
  bridge.identifyToolCalls(agent.toolIdOf?.bind(agent));
  // A tool pipeline error fails the step, as it does in `callModel`: it is
  // kept, the agent's turn is cancelled, and the error is thrown once the
  // turn has unwound.
  const turnError: TurnError = {};
  const bindingFor = (events: AcpEventBridge): HostBindingOptions<TContext, I, O> => ({
    step,
    ctx: baseCtx,
    questions,
    agentId: agent.agentId,
    layers,
    onUpdate: (notification) => {
      // A loaded session's history is not this turn's output.
      if (reloading) {
        return;
      }
      tools?.observe(notification.update);
      events.forward(notification);
    },
    onChildUpdate: (update) => {
      // A loaded session's history is not this turn's work, its subagents' included.
      if (reloading) {
        return;
      }
      // Its lineage first: a hold the announcement renames names the nested
      // agent only once the turn knows where it sits.
      events.forwardChild(update);
      tools?.observeChild(update.sessionId, update.update);
    },
    onActivity: (activity: AcpClientActivity) => {
      events.forwardActivity(activity);
    },
    tools,
    events,
    failTurn: (error: unknown) => {
      if (turnError.error !== undefined) {
        return;
      }
      turnError.error = error;
      void turnError.cancel?.().catch(() => undefined);
    },
  });
  const host = buildHost({
    ...bindingFor(bridge),
    cwd,
  });

  reloading = step.session?.load !== undefined && resumeId === undefined;
  if (reattach) {
    await ledger?.verifyHeld();
  }
  // The bridge starts accepting calls during the connection handshake.
  tools?.recordCallsAt(
    bridgePath,
    reattach === undefined ? 'fresh' : recorded?.stableCalls ? 'resume' : 'legacy',
  );
  const resolution = await openSession({
    step,
    agent,
    baseCtx,
    cwd,
    host,
    rebind: (host) => bindHostToStep(host, bindingFor(bridge)),
    tools,
    resumeId,
    reattach,
    fingerprint,
    settings,
    adapters,
  })
    .catch((cause: unknown) => {
      if (reattach && isAcpConnectError(cause) && !baseCtx.aborted) {
        throw new NoeticErrorImpl({
          kind: 'acp_link_lost',
          stepId: step.id,
          cause,
        });
      }
      throw stepFailure(step, cause, baseCtx);
    })
    .finally(() => {
      reloading = false;
    });
  // A live turn already has the mode and model under which it started.
  const selectedModel = resolution.reattached
    ? undefined
    : await applySessionSelection(step, ctx, resolution, baseCtx).catch((cause: unknown) => {
        throw stepFailure(step, cause, baseCtx);
      });
  turnError.cancel = () => resolution.live.session.cancel();
  const { connection, session } = resolution.live;
  // A shared session's last answer may belong to another step.
  const handle = step.session?.reuse ? undefined : connection.reattach;
  ledger?.noteEffect(position);
  scope.onRecorded(async (stored) => {
    const owns = await ledger?.verifyHeld().then(
      () => true,
      () => false,
    );
    if (
      sessions &&
      handle &&
      connection.detach &&
      (owns === false || (!stored && (!baseCtx.aborted || wasCut(baseCtx))))
    ) {
      await detachSession(resolution, baseCtx);
      return;
    }
    await finalizeSession(resolution, baseCtx);
    if (stored) {
      if (bridgePath?.startsWith('acp-tools:')) {
        await ledger?.dropWithin(bridgePath);
      }
      await sessions?.clear();
    }
  });
  const beforePrompt = async (prompt: PromptAttempt): Promise<void> => {
    await sessions?.write({
      sessionId: session.sessionId,
      agentId: agent.agentId,
      sent: true,
      promptHash,
      bridgePath,
      stableCalls: true,
      ...prompt,
      reattach: handle ?? recorded?.reattach,
      fingerprint: session.fingerprint ?? recorded?.fingerprint,
      subprocess: adapters.subprocess,
    });
    await ledger?.verifyHeld();
  };

  return promptAgent({
    step,
    baseCtx,
    layers,
    agent,
    bridge,
    resolution,
    bindingFor,
    tools,
    turnError,
    beforePrompt,
    beforeCollect: () => ledger?.verifyHeld(),
    prompt: {
      steering: recorded?.steering ?? 0,
      promptId: recorded?.promptId,
      guidance: recorded?.guidance,
    },
    sessions,
    keepPromptId: sessions !== undefined && (handle ?? recorded?.reattach) !== undefined,
    recovery: sessions ? (handle && connection.detach ? 'reattach' : 'unavailable') : undefined,
    collectRequired: recorded !== undefined && !recorded.sent,
    promptText,
    priorHistory,
    blocks,
    rerenderRequests,
    selectedModel,
  });
}

interface PromptAttempt {
  steering: number;
  promptId?: string;
  guidance?: string;
}

async function promptAgent<TContext, I, O>(params: {
  step: StepAcpAgent<TContext, I, O>;
  baseCtx: Context<ContextData>;
  layers: ContextLayer[] | undefined;
  agent: AcpAgent;
  bridge: AcpEventBridge;
  resolution: SessionResolution;
  bindingFor(events: AcpEventBridge): HostBindingOptions<TContext, I, O>;
  tools: AcpToolRunner | undefined;
  turnError: TurnError;
  beforePrompt(prompt: PromptAttempt): Promise<void>;
  beforeCollect(): Promise<void> | undefined;
  prompt: PromptAttempt;
  keepPromptId: boolean;
  sessions?: AcpSessionRecords;
  recovery?: 'reattach' | 'unavailable';
  collectRequired: boolean;
  promptText: string;
  priorHistory: Item[];
  blocks: ReadonlyArray<AcpContentBlock> | undefined;
  rerenderRequests: Awaited<ReturnType<typeof appendUserInput>>;
  selectedModel: string | undefined;
}): Promise<O> {
  const {
    step,
    baseCtx,
    layers,
    agent,
    resolution,
    bindingFor,
    tools,
    turnError,
    beforePrompt,
    beforeCollect,
    recovery,
    collectRequired,
    promptText,
    priorHistory,
    blocks,
    selectedModel,
  } = params;
  let { bridge, rerenderRequests } = params;
  // History seeds only a freshly opened session; a reused one already owns
  // its conversation on the agent side.
  // A reloaded session has its conversation too, and the work it had done.
  const { prompt } = params;
  let turnPrompt =
    prompt.guidance ??
    (resolution.reattached
      ? `${ACP_RESUME_NOTICE}\n\n${promptText}`
      : resolution.fresh
        ? withHistoryPrompt({
            prompt: promptText,
            history: priorHistory,
          })
        : promptText);
  let turnBlocks = prompt.guidance === undefined ? blocks : undefined;
  let collect = resolution.reattached;
  for (;;) {
    // Recall runs before every turn, as before every model call; its output
    // leads the prompt.
    const observation = baseCtx.harness._observeContext?.(baseCtx, step.id);
    const context = await renderLayerContext({
      ctx: baseCtx,
      layers,
      query: promptText,
      rerenderRequests,
      observation,
    }).catch((error: unknown) => {
      observation?.end();
      throw error;
    });
    rerenderRequests = [];
    const collectId = collect ? prompt.promptId : undefined;
    if (params.keepPromptId && prompt.promptId === undefined) {
      prompt.promptId = crypto.randomUUID();
    }
    const result = await runTurn({
      step,
      baseCtx,
      session: resolution.live.session,
      bridge,
      tools,
      turnError,
      collect,
      collectId,
      promptId: prompt.promptId,
      collectRequired,
      recovery,
      beforeCollect,
      beforePrompt: () => beforePrompt(prompt),
      content: buildContent({
        text: [
          context.text,
          turnPrompt,
        ]
          .filter((part) => part.length > 0)
          .join('\n\n'),
        blocks: turnBlocks,
      }),
      onPrompt:
        observation &&
        ((content) =>
          observation.request({
            target: 'acp',
            content,
            layerText: context.layerText,
          })),
    }).finally(() => observation?.end());
    collect = false;
    applyTurnResult(baseCtx, result);
    try {
      assertTurnSucceeded(step.id, result, baseCtx);
    } catch (e) {
      if (!wasCut(baseCtx)) {
        await finalizeSession(resolution, baseCtx);
      }
      throw e;
    }

    const response = toLlmResponse(result);
    const steer = () =>
      layers?.length
        ? baseCtx.harness.afterModelCall(layers, response, baseCtx)
        : Promise.resolve(undefined);
    const decision =
      layers?.length && params.sessions && prompt.promptId
        ? await params.sessions.decide(prompt.promptId, steer)
        : await steer();
    if (decision?.action === SteeringAction.Deny) {
      await finalizeSession(resolution, baseCtx);
      throw new NoeticErrorImpl({
        kind: 'steering_denied',
        guidance: decision.guidance,
      });
    }
    // A layer asking for a better answer gets another turn carrying its
    // guidance, as a `callModel` step retries its call. The agent keeps its
    // first answer in its own history, so it stays in the log as well.
    if (decision?.action === SteeringAction.Guide && prompt.steering < MAX_STEERING_RETRIES) {
      const guidance = decision.guidance ?? 'Please adjust your response.';
      baseCtx.itemLog.append(createMessage(guidance, 'developer'));
      turnPrompt = guidance;
      turnBlocks = undefined;
      prompt.steering += 1;
      prompt.guidance = guidance;
      prompt.promptId = undefined;
      bridge = new AcpEventBridge(step, baseCtx);
      bridge.identifyToolCalls(agent.toolIdOf?.bind(agent));
      bindHostToStep(resolution.live.host, bindingFor(bridge));
      continue;
    }
    publishStepMeta(baseCtx, result, currentModel(resolution.live.session, selectedModel));
    if (layers && layers.length > 0) {
      await baseCtx.harness.storeLayers(layers, response, baseCtx);
    }
    return await stepOutput(step, result);
  }
}
