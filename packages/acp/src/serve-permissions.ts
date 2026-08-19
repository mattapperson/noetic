/**
 * The server direction's permission gate: a context layer whose
 * `beforeToolCall` hook evaluates the declarative policy and, for `ask`
 * decisions, parks the pending call on a broker until the ACP client (or an
 * embedding host) answers `session/request_permission`.
 *
 * The gate leans on the core contract from spec 31: the hook is async and
 * awaited on every tool-executing path, receives the pending call's `callId`,
 * and runs after `tool_call_started` — so a parked call is visible to the
 * client as a pending `tool_call` rather than invisible until approved.
 */

import type { AcpToolKind, ContextLayer, SteeringDecision } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type {
  AcpServePermissionDecision,
  AcpServePermissionPolicy,
  AcpServePermissionPrompt,
  AcpServePermissionReply,
} from './serve-types';

//#region Policy evaluation

const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1e3;

/**
 * First decisive rule wins, checked `deny` → `ask` → `allow`; the policy
 * `default` (or `allow`) applies when nothing matches.
 * @public
 */
export function evaluateServePolicy(params: {
  policy: AcpServePermissionPolicy;
  toolName: string;
  kind?: AcpToolKind;
}): AcpServePermissionDecision {
  const { policy, toolName, kind } = params;
  const rules = policy.rules ?? [];
  const tiers: AcpServePermissionDecision[] = [
    'deny',
    'ask',
    'allow',
  ];
  for (const tier of tiers) {
    const matched = rules.some(
      (rule) =>
        rule.decision === tier &&
        ((rule.tool !== undefined && rule.tool === toolName) ||
          (rule.kind !== undefined && rule.kind === kind)),
    );
    if (matched) {
      return tier;
    }
  }
  return policy.default ?? 'allow';
}

//#endregion

//#region Broker

interface PendingAsk {
  sessionId: string;
  resolve(reply: AcpServePermissionReply): void;
}

/**
 * Holds `ask` parks and routes each to its answerer. The layer registers the
 * park *before* invoking `forward`, so an answer racing back in the same tick
 * still finds it; `cancelSession` unwinds every park for a session when the
 * client sends `session/cancel`.
 */
export class ServePermissionBroker {
  private readonly pending = new Map<string, PendingAsk>();

  constructor(
    private readonly forward: (
      prompt: AcpServePermissionPrompt,
    ) => Promise<AcpServePermissionReply>,
  ) {}

  async ask(prompt: AcpServePermissionPrompt, timeoutMs: number): Promise<AcpServePermissionReply> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const parked = new Promise<AcpServePermissionReply>((resolve) => {
      this.pending.set(prompt.requestId, {
        sessionId: prompt.sessionId,
        resolve,
      });
      timer = setTimeout(() => {
        this.answer(prompt.requestId, {
          decision: 'deny',
          reason: 'permission request timed out',
        });
      }, timeoutMs);
    });
    // The forwarder answers through `answer()` so a session cancel, the
    // deadline, and the client's reply all converge on the same park — first
    // one wins, the rest are no-ops.
    this.forward(prompt).then(
      (reply) => {
        this.answer(prompt.requestId, reply);
      },
      (error: unknown) => {
        this.answer(prompt.requestId, {
          decision: 'deny',
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    );
    try {
      return await parked;
    } finally {
      clearTimeout(timer);
      this.pending.delete(prompt.requestId);
    }
  }

  /** Resolve one park; later answers to the same request are dropped. */
  answer(requestId: string, reply: AcpServePermissionReply): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return;
    }
    this.pending.delete(requestId);
    entry.resolve(reply);
  }

  /** Unwind every park belonging to a session — the `session/cancel` path. */
  cancelSession(sessionId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionId !== sessionId) {
        continue;
      }
      this.pending.delete(requestId);
      entry.resolve({
        decision: 'cancel',
        reason: 'turn cancelled',
      });
    }
  }
}

//#endregion

//#region Gate layer

/** How a tool's name maps to its declared presentation, shared with the event pump. */
export interface ServeToolPresentation {
  kindOf(toolName: string): AcpToolKind | undefined;
  titleOf(toolName: string, args: unknown): string;
}

/**
 * Build the per-session gate layer. Slot is far past the built-in layers so
 * steering and other gates run first — a call another layer denies is never
 * escalated to the client.
 */
export function createServePermissionLayer(params: {
  sessionId: string;
  policy: AcpServePermissionPolicy;
  broker: ServePermissionBroker;
  presentation: ServeToolPresentation;
}): ContextLayer {
  const { sessionId, policy, broker, presentation } = params;
  const askTimeoutMs = policy.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;

  const beforeToolCall = async (hookParams: {
    toolName: string;
    toolArgs: unknown;
    callId?: string;
  }): Promise<{
    decision: SteeringDecision;
  }> => {
    const { toolName, toolArgs, callId } = hookParams;
    const kind = presentation.kindOf(toolName);
    const decision = evaluateServePolicy({
      policy,
      toolName,
      kind,
    });
    if (decision === 'allow') {
      return {
        decision: {
          action: 'allow',
        },
      };
    }
    if (decision === 'deny') {
      return {
        decision: {
          action: 'deny',
          guidance: `tool '${toolName}' is denied by the ACP serve policy`,
        },
      };
    }
    const reply = await broker.ask(
      {
        requestId: crypto.randomUUID(),
        sessionId,
        toolName,
        callId,
        title: presentation.titleOf(toolName, toolArgs),
        kind,
        args: toolArgs,
      },
      askTimeoutMs,
    );
    if (reply.decision === 'allow') {
      return {
        decision: {
          action: 'allow',
        },
      };
    }
    return {
      decision: {
        action: 'deny',
        guidance:
          reply.reason ??
          (reply.decision === 'cancel' ? 'turn cancelled' : 'the user rejected the tool call'),
      },
    };
  };

  return frameworkCast<ContextLayer>({
    id: `acp-serve-permissions:${sessionId}`,
    name: 'ACP serve permission gate',
    slot: 1e6,
    scope: 'execution',
    hooks: {
      beforeToolCall,
    },
    timeouts: {
      // The broker owns the real deadline (askTimeoutMs → deny); this outer
      // lifecycle timeout only backstops a wedged broker.
      beforeToolCall: askTimeoutMs + 10e3,
    },
    // A gate fails CLOSED: if the hook ever throws or blows the backstop
    // timeout, the lifecycle denies the call rather than abstaining into the
    // silent approval `mostRestrictive([])` would produce.
    onBeforeToolCallError: 'deny',
  });
}

//#endregion
