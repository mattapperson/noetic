import type {
  AfterModelCallParams,
  BeforeToolCallParams,
  ExecutionContext,
  LedgerEntry,
  MemoryLayer,
  MemoryScope,
  SteeringConfig,
  SteeringDecision,
  SteeringRule,
  SteeringState,
} from '@noetic-tools/types';
import {
  createMessage,
  estimateTokens,
  extractAssistantText,
  LedgerEntryKind,
  NoeticConfigError,
  Slot,
  SteeringAction,
} from '@noetic-tools/types';
import { mostRestrictive } from '../layer-lifecycle';

//#region Constants

const DEFAULT_MAX_LEDGER_ENTRIES = 100;

//#endregion

//#region Rule Evaluation Helpers

function requireCallModel(
  params: BeforeToolCallParams | AfterModelCallParams,
  ruleId: string,
): asserts params is (BeforeToolCallParams | AfterModelCallParams) & {
  ctx: {
    callModel: NonNullable<ExecutionContext['callModel']>;
  };
} {
  if (!params.ctx.callModel) {
    throw new NoeticConfigError({
      code: 'MISSING_CALL_MODEL',
      message: `LLM-evaluated steering rule "${ruleId}" requires a callModel but none is available.`,
      hint: 'Pass `llm: { provider: "openrouter", apiKey: "..." }` to AgentHarness or set OPENROUTER_API_KEY.',
    });
  }
}

function evaluateProgrammaticRule(
  rule: SteeringRule,
  params: BeforeToolCallParams | AfterModelCallParams,
): SteeringDecision | null {
  if (!rule.predicate) {
    return null;
  }
  return rule.predicate(params);
}

async function evaluateLlmRuleSync(
  rule: SteeringRule,
  params: BeforeToolCallParams | AfterModelCallParams,
): Promise<SteeringDecision> {
  if (!rule.llmEval) {
    return {
      action: SteeringAction.Allow,
    };
  }

  const { callModel } = params.ctx;
  if (!callModel) {
    return {
      action: SteeringAction.Allow,
    };
  }

  const contextSummary =
    'toolName' in params
      ? `Tool: ${params.toolName}, Args: ${JSON.stringify(params.toolArgs)}`
      : `Response items: ${params.response.items.length}`;

  const prompt = `${rule.llmEval.prompt}\n\nContext: ${contextSummary}\n\nRespond with exactly "ALLOW", "DENY", or "GUIDE: <guidance text>".`;

  const userMessage = createMessage(prompt, 'user');
  const model = rule.llmEval.model ?? 'openai/gpt-4o-mini';

  const response = await callModel({
    model,
    items: [
      userMessage,
    ],
  });
  const text = extractAssistantText(response.items).trim().toUpperCase();

  if (text.startsWith('DENY')) {
    return {
      action: SteeringAction.Deny,
      guidance: text.slice(5).trim() || undefined,
    };
  }
  if (text.startsWith('GUIDE:')) {
    return {
      action: SteeringAction.Guide,
      guidance: text.slice(6).trim(),
    };
  }
  return {
    action: SteeringAction.Allow,
  };
}

interface FireLlmRuleAsyncParams {
  rule: SteeringRule;
  params: BeforeToolCallParams | AfterModelCallParams;
  pendingAsync: SteeringState['pendingAsync'];
}

function fireLlmRuleAsync({ rule, params, pendingAsync }: FireLlmRuleAsyncParams): void {
  evaluateLlmRuleSync(rule, params)
    .then((decision) => {
      if (decision.action !== SteeringAction.Allow) {
        pendingAsync.push({
          ruleId: rule.id,
          guidance: decision.guidance ?? `Rule ${rule.id}: ${decision.action}`,
        });
      }
    })
    .catch(() => {
      // Async LLM eval failures are silently swallowed — they must not disrupt the agent
    });
}

function trimLedger(ledger: LedgerEntry[], max: number): LedgerEntry[] {
  if (ledger.length <= max) {
    return ledger;
  }
  return ledger.slice(ledger.length - max);
}

interface EvaluateRulesParams {
  rules: SteeringRule[];
  hookName: 'beforeToolCall' | 'afterModelCall';
  params: BeforeToolCallParams | AfterModelCallParams;
  state: SteeringState;
}

async function evaluateRules({
  rules,
  hookName,
  params,
  state,
}: EvaluateRulesParams): Promise<SteeringDecision> {
  const applicable = rules.filter((r) => r.appliesTo.includes(hookName));
  const decisions: SteeringDecision[] = [];

  for (const rule of applicable) {
    // Programmatic predicate (fast)
    const programmatic = evaluateProgrammaticRule(rule, params);
    if (programmatic) {
      decisions.push(programmatic);
      if (programmatic.action === SteeringAction.Deny) {
        return mostRestrictive(decisions);
      }
      continue;
    }

    // LLM eval — throws NoeticConfigError if callModel is missing
    if (!rule.llmEval) {
      continue;
    }

    requireCallModel(params, rule.id);

    if (rule.llmEval.mode === 'sync') {
      const decision = await evaluateLlmRuleSync(rule, params);
      decisions.push(decision);
      if (decision.action === SteeringAction.Deny) {
        return mostRestrictive(decisions);
      }
      continue;
    }

    // Async — fire and forget
    fireLlmRuleAsync({
      rule,
      params,
      pendingAsync: state.pendingAsync,
    });
  }

  return mostRestrictive(decisions);
}

//#endregion

//#region Public API

/**
 * Creates a steering memory layer that evaluates rules before tool calls and after model calls.
 *
 * @public
 * @param config - Steering configuration including rules, scope, and max ledger size.
 * @returns A `MemoryLayer` that enforces steering rules via allow/deny/guide decisions.
 */
export function steering(config: SteeringConfig) {
  const maxLedger = config.maxLedgerEntries ?? DEFAULT_MAX_LEDGER_ENTRIES;
  const scope: MemoryScope = config.scope ?? 'execution';

  return {
    id: 'steering' as const,
    name: 'Steering',
    slot: Slot.STEERING,
    scope,
    budget: {
      min: 0,
      max: 500,
    },
    timeouts: {
      beforeToolCall: 5e3,
      afterModelCall: 1e4,
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<SteeringState>('state');
        const state: SteeringState = saved ?? {
          ledger: [],
          pendingAsync: [],
        };
        return {
          state,
        };
      },

      async recall({ state }) {
        if (state.pendingAsync.length === 0) {
          return null;
        }
        const feedback = state.pendingAsync.map((p) => `[${p.ruleId}] ${p.guidance}`).join('\n');
        state.pendingAsync = [];
        const content = `<steering_feedback>\n${feedback}\n</steering_feedback>`;
        return {
          items: [
            createMessage(content, 'developer'),
          ],
          tokenCount: estimateTokens(content),
          state,
        };
      },

      async store() {
        // Model turn ledger entries are recorded in afterModelCall to avoid duplicates
        return undefined;
      },

      async beforeToolCall({ toolName, toolArgs, ctx, state }) {
        const decision = await evaluateRules({
          rules: config.rules,
          hookName: 'beforeToolCall',
          params: {
            toolName,
            toolArgs,
            ctx,
            state,
          },
          state,
        });

        const entry: LedgerEntry = {
          kind: LedgerEntryKind.ToolCall,
          timestamp: Date.now(),
          toolName,
          toolArgs,
          ruleId: decision.action !== SteeringAction.Allow ? 'steering' : undefined,
          action: decision.action,
          guidance: decision.guidance,
        };
        state.ledger.push(entry);
        state.ledger = trimLedger(state.ledger, maxLedger);

        return {
          decision,
          state,
        };
      },

      async afterModelCall({ response, ctx, state }) {
        const decision = await evaluateRules({
          rules: config.rules,
          hookName: 'afterModelCall',
          params: {
            response,
            ctx,
            state,
          },
          state,
        });

        const entry: LedgerEntry = {
          kind: LedgerEntryKind.ModelTurn,
          timestamp: Date.now(),
          tokenUsage: {
            input: response.usage.inputTokens,
            output: response.usage.outputTokens,
          },
          ruleId: decision.action !== SteeringAction.Allow ? 'steering' : undefined,
          action: decision.action,
          guidance: decision.guidance,
        };
        state.ledger.push(entry);
        state.ledger = trimLedger(state.ledger, maxLedger);

        return {
          decision,
          state,
        };
      },

      async onSpawn({ parentState }) {
        return {
          childState: {
            ledger: structuredClone(parentState.ledger),
            pendingAsync: [],
          },
        };
      },

      async onComplete({ state, outcome }) {
        const entry: LedgerEntry = {
          kind: LedgerEntryKind.Custom,
          timestamp: Date.now(),
          custom: {
            outcome,
          },
        };
        state.ledger.push(entry);
        state.ledger = trimLedger(state.ledger, maxLedger);
        return {
          state,
        };
      },
    },
  } satisfies MemoryLayer<SteeringState>;
}

//#endregion
