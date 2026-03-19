import type { CallModelFn } from '../../interpreter/execute-llm';
import { createMessage, estimateTokens } from '../../interpreter/message-helpers';
import type { MemoryLayer, MemoryScope } from '../../types/memory';
import { Slot } from '../../types/memory';
import type {
  AfterModelCallParams,
  BeforeToolCallParams,
  LedgerEntry,
  SteeringConfig,
  SteeringDecision,
  SteeringRule,
  SteeringState,
} from '../../types/steering';
import { LedgerEntryKind, SteeringAction } from '../../types/steering';
import { mostRestrictive } from '../layer-lifecycle';

//#region Constants

const DEFAULT_MAX_LEDGER_ENTRIES = 100;

//#endregion

//#region Rule Evaluation Helpers

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
  callModel: CallModelFn,
): Promise<SteeringDecision> {
  if (!rule.llmEval) {
    return {
      action: SteeringAction.Allow,
    };
  }

  const contextSummary =
    'toolName' in params
      ? `Tool: ${params.toolName}, Args: ${JSON.stringify(params.toolArgs)}`
      : `Response items: ${params.response.items.length}`;

  const prompt = `${rule.llmEval.prompt}\n\nContext: ${contextSummary}\n\nRespond with exactly "ALLOW", "DENY", or "GUIDE: <guidance text>".`;

  const response = await callModel({
    model: rule.llmEval.model ?? params.ctx.model ?? 'openai/gpt-4o-mini',
    items: [
      {
        id: crypto.randomUUID(),
        status: 'completed',
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt,
          },
        ],
      },
    ],
    ctx: {
      id: params.ctx.executionId,
      stepCount: 0,
      tokens: {
        input: 0,
        output: 0,
        total: 0,
      },
      elapsed: 0,
      cost: 0,
      state: {},
      parent: null,
      depth: 0,
      span: {
        traceId: 't',
        spanId: 's',
        parentSpanId: null,
        setAttribute() {},
        addEvent() {},
        end() {},
      },
      threadId: params.ctx.threadId,
      itemLog: {
        items: [],
        append() {},
      },
      lastStepMeta: null,
      recv: async () => {
        throw new Error('not available in steering eval');
      },
      send: () => {
        throw new Error('not available in steering eval');
      },
      tryRecv: () => {
        throw new Error('not available in steering eval');
      },
      checkpoint: async () => {},
      complete: () => {},
      completed: false,
      completionValue: undefined,
      aborted: false,
      abort: () => {},
    },
  });

  const text = response.items
    .filter(
      (
        i,
      ): i is Extract<
        typeof i,
        {
          type: 'message';
        }
      > => i.type === 'message',
    )
    .flatMap((m) => m.content)
    .filter(
      (
        c,
      ): c is Extract<
        typeof c,
        {
          type: 'output_text';
        }
      > => c.type === 'output_text',
    )
    .map((c) => c.text)
    .join('')
    .trim()
    .toUpperCase();

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
  callModel: CallModelFn;
  pendingAsync: SteeringState['pendingAsync'];
}

function fireLlmRuleAsync({ rule, params, callModel, pendingAsync }: FireLlmRuleAsyncParams): void {
  evaluateLlmRuleSync(rule, params, callModel)
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
  callModel?: CallModelFn;
}

async function evaluateRules({
  rules,
  hookName,
  params,
  state,
  callModel,
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

    // LLM eval
    if (!rule.llmEval || !callModel) {
      continue;
    }

    if (rule.llmEval.mode === 'sync') {
      const decision = await evaluateLlmRuleSync(rule, params, callModel);
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
      callModel,
      pendingAsync: state.pendingAsync,
    });
  }

  return mostRestrictive(decisions);
}

//#endregion

//#region Public API

export function steering(config: SteeringConfig): MemoryLayer<SteeringState> {
  const maxLedger = config.maxLedgerEntries ?? DEFAULT_MAX_LEDGER_ENTRIES;
  const scope: MemoryScope = config.scope ?? 'execution';

  return {
    id: 'steering',
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
          callModel: config.callModel,
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
          callModel: config.callModel,
        });

        const entry: LedgerEntry = {
          kind: LedgerEntryKind.ModelTurn,
          timestamp: Date.now(),
          model: ctx.model,
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
  };
}

//#endregion
