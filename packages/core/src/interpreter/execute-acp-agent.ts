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
import { ACP_RESUME_NOTICE, acpSessionRecords } from './acp-resume';
import type { SessionResolution } from './acp-session';
import {
  applySessionSelection,
  assertReuseIsKeptAlive,
  discardIfFresh,
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

/**
 * A resumed step that now runs through another subprocess adapter than the one
 * its agent was started through. The agent may still be working where it was
 * started, so the step fails and attaches to nothing: starting its work again
 * elsewhere could do it twice.
 */
function movedAgent(stepId: string, started: string, now: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'ACP_SESSION_ADAPTER_CONFLICT',
    message: `step.acpAgent(${JSON.stringify(stepId)}) resumes an agent started through the subprocess adapter '${started}', but now runs through '${now}'.`,
    hint: `Resume with the step, its agent and \`environment.subprocess\` resolving to '${started}', as in the run that started the agent.`,
  });
}

/** Whether a step setting may name anything: a getter, or a non-empty array. */
function gives(setting: unknown): boolean {
  return typeof setting === 'function' || (Array.isArray(setting) && setting.length > 0);
}

export async function executeAcpAgent<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  layers?: ContextLayer[],
): Promise<O> {
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
    return await runAcpStep({
      step,
      input,
      ctx,
      layers,
      agent,
      questions,
    });
  } finally {
    await questions.release().catch(() => undefined);
  }
}

async function runAcpStep<TContext, I, O>(params: {
  step: StepAcpAgent<TContext, I, O>;
  input: I;
  ctx: Context<TContext>;
  layers: ContextLayer[] | undefined;
  agent: AcpAgent;
  questions: QuestionAsker;
}): Promise<O> {
  const { step, input, ctx, layers, agent, questions } = params;
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

  // An earlier attempt of this step may have left its session behind.
  const sessions = step.session?.load ? undefined : acpSessionRecords(baseCtx);
  const recorded = await sessions?.load();
  const sameAgent = recorded?.agentId === agent.agentId;
  const resumeId = sameAgent ? recorded?.sessionId : undefined;
  const reattach = sameAgent ? recorded?.reattach : undefined;
  if (
    reattach &&
    recorded?.subprocess !== undefined &&
    recorded.subprocess !== adapters.subprocess
  ) {
    throw movedAgent(step.id, recorded.subprocess, adapters.subprocess);
  }
  const fingerprint = sameAgent ? recorded?.fingerprint : undefined;
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

  // Both an explicit `session.load` and the resume of an earlier attempt's
  // session load it; a reused live session is not reloaded and replays nothing.
  reloading = resumeId !== undefined || step.session?.load !== undefined;
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
      throw stepFailure(step, cause, baseCtx);
    })
    .finally(() => {
      reloading = false;
    });
  if (resolution.resumed) {
    tools?.sessionReloaded();
  }
  // A reloaded session was opened again with this step's settings: its record
  // takes the new fingerprint. A reattached one keeps the one it has.
  if (resolution.fresh && !resolution.reattached) {
    await sessions?.write({
      sessionId: resolution.live.session.sessionId,
      agentId: agent.agentId,
      // How a resumed run reaches this agent if it outlives this host.
      reattach: resolution.live.connection.reattach,
      fingerprint: resolution.live.session.fingerprint,
      subprocess: adapters.subprocess,
    });
  }

  const selectedModel = await applySessionSelection(step, ctx, resolution, baseCtx).catch(
    (cause: unknown) => {
      throw stepFailure(step, cause, baseCtx);
    },
  );
  turnError.cancel = () => resolution.live.session.cancel();

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
    sessions,
    promptText,
    priorHistory,
    blocks,
    rerenderRequests,
    selectedModel,
  });
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
  sessions: ReturnType<typeof acpSessionRecords>;
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
    sessions,
    promptText,
    priorHistory,
    blocks,
    selectedModel,
  } = params;
  let { bridge, rerenderRequests } = params;
  // History seeds only a freshly opened session; a reused one already owns
  // its conversation on the agent side.
  // A reloaded session has its conversation too, and the work it had done.
  let turnPrompt = resolution.resumed
    ? `${ACP_RESUME_NOTICE}\n\n${promptText}`
    : resolution.fresh
      ? withHistoryPrompt({
          prompt: promptText,
          history: priorHistory,
        })
      : promptText;
  let turnBlocks = blocks;
  let retries = 0;
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
    const result = await runTurn({
      step,
      baseCtx,
      session: resolution.live.session,
      discard: () => discardIfFresh(resolution, baseCtx),
      bridge,
      tools,
      turnError,
      collect: retries === 0 && resolution.reattached,
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
    applyTurnResult(baseCtx, result);
    try {
      assertTurnSucceeded(step.id, result, baseCtx);
    } catch (e) {
      await finalizeSession(resolution, baseCtx);
      throw e;
    }

    const response = toLlmResponse(result);
    const decision =
      layers && layers.length > 0
        ? await baseCtx.harness.afterModelCall(layers, response, baseCtx)
        : undefined;
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
    if (decision?.action === SteeringAction.Guide && retries < MAX_STEERING_RETRIES) {
      const guidance = decision.guidance ?? 'Please adjust your response.';
      baseCtx.itemLog.append(createMessage(guidance, 'developer'));
      turnPrompt = guidance;
      turnBlocks = undefined;
      retries += 1;
      bridge = new AcpEventBridge(step, baseCtx);
      bridge.identifyToolCalls(agent.toolIdOf?.bind(agent));
      bindHostToStep(resolution.live.host, bindingFor(bridge));
      continue;
    }
    publishStepMeta(baseCtx, result, currentModel(resolution.live.session, selectedModel));
    if (layers && layers.length > 0) {
      await baseCtx.harness.storeLayers(layers, response, baseCtx);
    }
    await finalizeSession(resolution, baseCtx);
    await sessions?.clear();
    return await stepOutput(step, result);
  }
}
