import type { AgentHarnessContract, Context, SteeringDecision } from '@noetic-tools/types';
import { SteeringAction } from '@noetic-tools/types';

//#region Types

/** How the approval stage settled a call, as recorded on its `tool.call` span. */
export const ApprovalOutcome = {
  Approved: 'approved',
  Denied: 'denied',
  /** The harness has no approver, so the call ran unapproved. */
  NoneConfigured: 'none_configured',
} as const;

export type ApprovalOutcome = (typeof ApprovalOutcome)[keyof typeof ApprovalOutcome];

export interface ToolApproval {
  outcome: ApprovalOutcome;
  decision: SteeringDecision;
}

//#endregion

//#region Public API

/**
 * Ask the harness approver whether a call to a tool that declares
 * `needsApproval` may run. With no approver configured the call runs, and the
 * harness warns once per tool name. An approver that throws denies the call.
 */
export async function askApproval(params: {
  harness: AgentHarnessContract;
  toolName: string;
  toolArgs: unknown;
  callId?: string;
  ctx: Context;
}): Promise<ToolApproval> {
  const approver = params.harness.config.approveToolCall;
  if (!approver) {
    warnOnce(params.harness, params.toolName);
    return {
      outcome: ApprovalOutcome.NoneConfigured,
      decision: {
        action: SteeringAction.Allow,
      },
    };
  }
  try {
    const decision = await approver({
      toolName: params.toolName,
      toolArgs: params.toolArgs,
      callId: params.callId,
      ctx: params.ctx,
    });
    return {
      outcome:
        decision.action === SteeringAction.Allow
          ? ApprovalOutcome.Approved
          : ApprovalOutcome.Denied,
      decision,
    };
  } catch (e) {
    return {
      outcome: ApprovalOutcome.Denied,
      decision: {
        action: SteeringAction.Deny,
        guidance: `approval for tool '${params.toolName}' failed: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
}

//#endregion

//#region Helpers

const warned = new WeakMap<AgentHarnessContract, Set<string>>();

function warnOnce(harness: AgentHarnessContract, toolName: string): void {
  let names = warned.get(harness);
  if (!names) {
    names = new Set();
    warned.set(harness, names);
  }
  if (names.has(toolName)) {
    return;
  }
  names.add(toolName);
  console.warn(
    `[noetic] tool '${toolName}' needs approval, but harness '${harness.config.name}' has no approver, so its calls run unapproved. Set AgentHarness({ approveToolCall }) to approve or refuse them.`,
  );
}

//#endregion
