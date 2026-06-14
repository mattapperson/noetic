/**
 * SubHarness step handler: drives an external coding-agent harness
 * (Claude Code, Codex, opencode, pi) for one agentic turn and folds its output
 * back into the Noetic execution context — the harness analogue of
 * `executeLLM`.
 */

import type {
  Context,
  ContextMemory,
  FunctionCallItem,
  Item,
  LLMResponse,
  StepMeta,
  StepSubHarness,
  SubHarness,
  SubHarnessRunContext,
  SubHarnessSession,
  SubHarnessSessionPolicy,
  SubHarnessTurnResult,
} from '@noetic-tools/types';
import {
  createMessage,
  extractAssistantText,
  frameworkCast,
  NoeticConfigError,
  NoeticErrorImpl,
} from '@noetic-tools/types';
import { ZodError } from 'zod';
import { resolveLazy } from './execute-action';
import { trackUsage } from './message-helpers';
import { SubHarnessEventBridge } from './sub-harness-events';
import { isFunctionCall, isMutableContext } from './typeguards';

//#region Types

/**
 * Cross-step harness session store, hung off the concrete `AgentHarness` so
 * sessions keyed by `step.session.reuse` survive between steps in one run.
 * Not on the public `ContextHarness` surface — reached via `frameworkCast`,
 * mirroring how the interpreter reaches `layerStateStore`.
 */
interface SubHarnessSessionStore {
  subHarnessSessions: Map<string, SubHarnessSession>;
}

type TeardownMode = NonNullable<SubHarnessSessionPolicy['onComplete']>;

//#endregion

//#region Helpers

function sessionStore(ctx: Context<ContextMemory>): Map<string, SubHarnessSession> {
  return frameworkCast<SubHarnessSessionStore>(ctx.harness).subHarnessSessions;
}

async function resolveSubHarness<TMemory, I, O>(
  step: StepSubHarness<TMemory, I, O>,
  ctx: Context<TMemory>,
): Promise<SubHarness> {
  const resolved = await resolveLazy(step.harness, ctx);
  if (!resolved) {
    throw new NoeticConfigError({
      code: 'MISSING_SUB_HARNESS',
      message: `step.${step.kind}(${JSON.stringify(step.id)}) resolved no harness adapter.`,
      hint: 'Pass a harness factory result, e.g. harness: claudeCode({ model }).',
    });
  }
  if (resolved.harnessId !== step.kind) {
    throw new NoeticConfigError({
      code: 'SUB_HARNESS_KIND_MISMATCH',
      message: `step.${step.kind}(${JSON.stringify(step.id)}) was given a '${resolved.harnessId}' harness.`,
      hint: `Use the matching builder for this adapter, e.g. step.${resolved.harnessId}({ ... }).`,
    });
  }
  return resolved;
}

function resolveTurnText<I>(resolvedPrompt: string | undefined, input: I): string {
  if (resolvedPrompt && resolvedPrompt.length > 0) {
    return resolvedPrompt;
  }
  return typeof input === 'string' ? input : '';
}

function buildRunContext(ctx: Context<ContextMemory>): SubHarnessRunContext {
  return {
    cwd: ctx.cwdState.cwd,
    fs: ctx.fs,
    shell: ctx.shell,
    subprocess: ctx.subprocess,
    threadId: ctx.threadId,
  };
}

function toLlmResponse(result: SubHarnessTurnResult): LLMResponse {
  const usage = result.usage;
  return {
    items: result.items,
    usage: {
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      cachedTokens: usage?.cached,
    },
    cost: result.cost,
  };
}

function applyTurnResult(ctx: Context<ContextMemory>, result: SubHarnessTurnResult): void {
  const toolCalls: FunctionCallItem[] = [];
  for (const item of result.items) {
    ctx.itemLog.append(item);
    if (isFunctionCall(item)) {
      toolCalls.push(item);
    }
  }

  const llmResponse = toLlmResponse(result);
  trackUsage(ctx, llmResponse);

  const meta: StepMeta = {
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: result.usage ? llmResponse.usage : undefined,
    cost: result.cost,
    responseItems: result.items,
  };
  if (isMutableContext(ctx)) {
    ctx.lastStepMeta = meta;
  }
}

async function teardownSession(session: SubHarnessSession, mode: TeardownMode): Promise<void> {
  if (mode === 'detach' && session.doDetach) {
    await session.doDetach();
    return;
  }
  if (mode === 'destroy' && session.doDestroy) {
    await session.doDestroy();
    return;
  }
  await session.doStop();
}

interface SessionResolution {
  session: SubHarnessSession;
  reuseKey?: string;
}

async function startOrReuseSession<TMemory, I, O>(
  step: StepSubHarness<TMemory, I, O>,
  harness: SubHarness,
  ctx: Context<TMemory>,
  baseCtx: Context<ContextMemory>,
  history: ReadonlyArray<Item>,
): Promise<SessionResolution> {
  const reuseKey = step.session?.reuse;
  const store = sessionStore(baseCtx);
  if (reuseKey) {
    const existing = store.get(reuseKey);
    if (existing) {
      return {
        session: existing,
        reuseKey,
      };
    }
  }

  const session = await harness.doStart({
    settings: step.settings,
    instructions: await resolveLazy(step.instructions, ctx),
    history,
    ctx: buildRunContext(baseCtx),
  });
  if (reuseKey) {
    store.set(reuseKey, session);
  }
  return {
    session,
    reuseKey,
  };
}

/**
 * Tear the session down per policy after a successful turn. Reused sessions
 * stay alive by default; an explicit `onComplete` overrides that.
 */
async function finalizeSession(
  resolution: SessionResolution,
  policy: SubHarnessSessionPolicy | undefined,
  baseCtx: Context<ContextMemory>,
): Promise<void> {
  const { session, reuseKey } = resolution;
  if (!reuseKey) {
    await teardownSession(session, policy?.onComplete ?? 'stop');
    return;
  }
  const mode = policy?.onComplete;
  if (mode === 'stop' || mode === 'destroy') {
    await teardownSession(session, mode);
    sessionStore(baseCtx).delete(reuseKey);
    return;
  }
  if (mode === 'detach') {
    await teardownSession(session, 'detach');
  }
  // Default for a reused session: keep it alive in the store.
}

//#endregion

//#region Public API

export async function executeSubHarness<TMemory, I, O>(
  step: StepSubHarness<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);

  const harness = await resolveSubHarness(step, ctx);
  const resolvedPrompt = await resolveLazy(step.prompt, ctx);
  const turnText = resolveTurnText(resolvedPrompt, input);
  if (turnText.trim() === '') {
    throw new NoeticConfigError({
      code: 'MISSING_PROMPT',
      message: `step.${step.kind}(${JSON.stringify(step.id)}) resolved an empty prompt.`,
      hint: 'Provide a non-empty `prompt`, or pass a string input to the step.',
    });
  }

  // Capture the conversation so far (from earlier LLM/sub-harness steps and
  // turns) BEFORE appending this turn's prompt, so a fresh session is seeded
  // with full context of the conversation.
  const priorHistory: Item[] = [
    ...baseCtx.itemLog.items,
  ];
  baseCtx.itemLog.append(createMessage(turnText, 'user'));

  const resolution = await startOrReuseSession(step, harness, ctx, baseCtx, priorHistory);
  const bridge = new SubHarnessEventBridge(step, baseCtx);
  bridge.begin();

  let result: SubHarnessTurnResult;
  try {
    result = await resolution.session.doPromptTurn({
      prompt: turnText,
      emit: (part) => bridge.forward(part),
    });
  } catch (e) {
    // Best-effort teardown of a fresh session before surfacing the failure;
    // reused sessions are left intact for a later step to retry against.
    if (!resolution.reuseKey) {
      await teardownSession(resolution.session, 'destroy').catch(() => undefined);
    }
    if (e instanceof NoeticErrorImpl) {
      throw e;
    }
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: e instanceof Error ? e : new Error(String(e)),
      retriesExhausted: false,
    });
  }

  bridge.finalize(result);
  applyTurnResult(baseCtx, result);
  await finalizeSession(resolution, step.session, baseCtx);

  const lastText = result.text.length > 0 ? result.text : extractAssistantText(result.items);

  if (step.output) {
    try {
      const parsed = JSON.parse(lastText);
      return step.output.parse(parsed);
    } catch (e) {
      if (e instanceof SyntaxError || e instanceof ZodError) {
        throw new NoeticErrorImpl({
          kind: 'llm_parse_error',
          stepId: step.id,
          raw: lastText,
          schema: step.output,
          zodError:
            e instanceof ZodError
              ? e
              : new ZodError([
                  {
                    code: 'custom',
                    message: `Invalid JSON: ${e.message}`,
                    path: [],
                  },
                ]),
        });
      }
      throw e;
    }
  }

  return frameworkCast<O>(lastText);
}

//#endregion
