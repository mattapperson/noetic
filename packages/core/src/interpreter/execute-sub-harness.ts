/**
 * SubHarness step handler: drives an external coding-agent harness
 * (Claude Code, Codex, opencode, pi) for one agentic turn and folds its output
 * back into the Noetic execution context — the harness analogue of
 * `executeCallModel`.
 */

import type {
  Context,
  ContextData,
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
import { resolveLazy } from './execute-action';
import { trackUsage } from './message-helpers';
import { parseStructuredOutput } from './structured-output';
import { SubHarnessEventBridge } from './sub-harness-events';
import { isContextImpl, isFunctionCall, isMutableContext } from './typeguards';

//#region Types

/**
 * Cross-step harness session store, hung off the concrete `AgentHarness` so
 * sessions keyed by `step.session.reuse` survive between steps in one run.
 * Not on the public `ContextHarness` surface — reached via `frameworkCast`,
 * mirroring how the interpreter reaches `layerStateStore`.
 */
interface SubHarnessSessionStore {
  /**
   * Keyed by `step.session.reuse`. Values are PROMISES so two steps racing on
   * the same key (e.g. parallel legs) dedupe onto one `doStart` instead of
   * both starting and one leaking. Driving concurrent TURNS on one reused
   * session remains unsupported — sessions are conversational state.
   */
  subHarnessSessions: Map<string, Promise<SubHarnessSession>>;
}

type TeardownMode = NonNullable<SubHarnessSessionPolicy['onComplete']>;

//#endregion

//#region Helpers

function sessionStore(ctx: Context<ContextData>): Map<string, Promise<SubHarnessSession>> {
  return frameworkCast<SubHarnessSessionStore>(ctx.harness).subHarnessSessions;
}

async function resolveSubHarness<TContext, I, O>(
  step: StepSubHarness<TContext, I, O>,
  ctx: Context<TContext>,
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

/**
 * Abort signal of the executing context, when it is a framework context. Handed
 * to the adapter so `ctx.abort()` / `harness.cancel()` stops the coding agent's
 * in-flight turn instead of leaving a sub-process running until it finishes.
 */
function abortSignalOf(ctx: Context<ContextData>): AbortSignal | undefined {
  return isContextImpl(ctx) ? ctx.abortSignal : undefined;
}

/** Default idle timeout for a sub-harness turn; `settings.extra.idleTimeoutMs` overrides (0 disables). */
const DEFAULT_SUB_HARNESS_IDLE_TIMEOUT_MS = 120_000;

function resolveIdleTimeoutMs(extra: Record<string, unknown> | undefined): number {
  const raw = extra?.idleTimeoutMs;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  return DEFAULT_SUB_HARNESS_IDLE_TIMEOUT_MS;
}

function buildRunContext(ctx: Context<ContextData>): SubHarnessRunContext {
  return {
    cwd: ctx.cwdState.cwd,
    fs: ctx.fs,
    shell: ctx.shell,
    subprocess: ctx.subprocess,
    threadId: ctx.threadId,
    signal: abortSignalOf(ctx),
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

function applyTurnResult(ctx: Context<ContextData>, result: SubHarnessTurnResult): void {
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

/**
 * Start one session. Kept as a named function so callers can hold the pending
 * promise — it returns synchronously, before the instruction resolve inside it
 * awaits, which is what lets the reuse store be populated without a dedupe
 * window.
 */
function startSession<TContext, I, O>(
  step: StepSubHarness<TContext, I, O>,
  harness: SubHarness,
  ctx: Context<TContext>,
  baseCtx: Context<ContextData>,
  history: ReadonlyArray<Item>,
): Promise<SubHarnessSession> {
  return resolveLazy(step.instructions, ctx).then((instructions) =>
    harness.doStart({
      settings: step.settings,
      instructions,
      history,
      ctx: buildRunContext(baseCtx),
      signal: abortSignalOf(baseCtx),
    }),
  );
}

async function startOrReuseSession<TContext, I, O>(
  step: StepSubHarness<TContext, I, O>,
  harness: SubHarness,
  ctx: Context<TContext>,
  baseCtx: Context<ContextData>,
  history: ReadonlyArray<Item>,
): Promise<SessionResolution> {
  const reuseKey = step.session?.reuse;
  const store = sessionStore(baseCtx);
  if (reuseKey) {
    const existing = store.get(reuseKey);
    if (existing) {
      return {
        session: await existing,
        reuseKey,
      };
    }
  }

  // Build the start promise SYNCHRONOUSLY (the instruction resolve happens
  // inside it) so the store.set below lands before any await — otherwise two
  // steps racing on the key both pass the store check during the instruction
  // resolution and start duplicate sessions.
  const startPromise = startSession(step, harness, ctx, baseCtx, history);
  if (reuseKey) {
    store.set(reuseKey, startPromise);
    try {
      return {
        session: await startPromise,
        reuseKey,
      };
    } catch (e) {
      // A failed start must not poison the key for later retries.
      store.delete(reuseKey);
      throw e;
    }
  }
  return {
    session: await startPromise,
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
  baseCtx: Context<ContextData>,
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

export async function executeSubHarness<TContext, I, O>(
  step: StepSubHarness<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);

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

  // Idle watchdog: an external coding agent is a real process that can hang
  // (CLI waiting on stdin, SDK deadlock). The model-call path has a
  // stream-idle watchdog; this is its analogue for sub-harness turns — no
  // stream part for `idleTimeoutMs` aborts the per-turn signal. Every
  // forwarded part feeds the watchdog.
  const idleTimeoutMs = resolveIdleTimeoutMs(step.settings?.extra);
  const turnController = new AbortController();
  const ctxSignal = abortSignalOf(baseCtx);
  const turnSignal = ctxSignal
    ? AbortSignal.any([
        ctxSignal,
        turnController.signal,
      ])
    : turnController.signal;
  let idleStalled = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armWatchdog = (): void => {
    if (idleTimeoutMs <= 0) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      idleStalled = true;
      turnController.abort(`sub-harness turn idle for ${idleTimeoutMs}ms`);
    }, idleTimeoutMs);
  };
  armWatchdog();

  let result: SubHarnessTurnResult;
  try {
    result = await resolution.session.doPromptTurn({
      prompt: turnText,
      emit: (part) => {
        armWatchdog();
        bridge.forward(part);
      },
      // Per-turn signal, so a session reused across turns is cancelled by the
      // context running the CURRENT turn rather than the one that started it,
      // and the idle watchdog can cut a stalled turn.
      signal: turnSignal,
    });
  } catch (e) {
    // A failed turn may leave the external runtime wedged or partially
    // advanced. Never reuse it: evict the promise before best-effort teardown.
    if (resolution.reuseKey) {
      sessionStore(baseCtx).delete(resolution.reuseKey);
    }
    await teardownSession(resolution.session, 'destroy').catch(() => undefined);
    if (e instanceof NoeticErrorImpl) {
      throw e;
    }
    // An adapter interrupted by the abort signal rejects with whatever its SDK
    // throws; the context is the authority on why the turn ended.
    if (baseCtx.aborted) {
      throw new NoeticErrorImpl({
        kind: 'cancelled',
        reason: baseCtx.abortReason ?? 'context aborted',
      });
    }
    if (idleStalled) {
      throw new NoeticErrorImpl({
        kind: 'step_failed',
        stepId: step.id,
        cause: new Error(
          `Sub-harness turn produced no output for ${idleTimeoutMs}ms (idle timeout).`,
        ),
        retriesExhausted: false,
      });
    }
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: e instanceof Error ? e : new Error(String(e)),
      retriesExhausted: false,
    });
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  }

  bridge.finalize(result);
  applyTurnResult(baseCtx, result);

  // A turn the AGENT reports as failed must not flow downstream as a normal
  // answer. The items/usage are already applied (the spend is real and the
  // transcript is the evidence); the step itself fails so loop onError /
  // callers can retry or abort instead of trusting a broken result.
  if (result.finishReason === 'error') {
    if (resolution.reuseKey) {
      sessionStore(baseCtx).delete(resolution.reuseKey);
    }
    await teardownSession(resolution.session, 'destroy').catch(() => undefined);
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(
        `Sub-harness turn finished with finishReason 'error'. Last output: ${
          (result.text || extractAssistantText(result.items)).slice(0, 500) || '(none)'
        }`,
      ),
      retriesExhausted: false,
    });
  }

  await finalizeSession(resolution, step.session, baseCtx);

  const lastText = result.text.length > 0 ? result.text : extractAssistantText(result.items);

  if (step.output) {
    return parseStructuredOutput<O>({
      schema: step.output,
      rawText: lastText,
      stepId: step.id,
    });
  }

  return frameworkCast<O>(lastText);
}

//#endregion
