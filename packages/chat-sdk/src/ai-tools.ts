import type { Tool, ToolExecutionContext } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { approvalDecisions, approvalRequests } from './approvals';

const DEFAULT_APPROVAL_TIMEOUT = 300_000; // 5 minutes for a human to click a button

/** Structural subset of an AI SDK tool (`ai` package `Tool`). */
export interface AiSdkToolLike {
  description?: string;
  /** Zod schema on AI SDK tools; validated at runtime by the harness. */
  inputSchema?: unknown;
  /** AI SDK approval flag — boolean or a dynamic predicate. */
  needsApproval?: unknown;
  execute?: (input: unknown, options: unknown) => unknown;
}

export interface FromAiSdkToolOptions {
  /**
   * Park the tool on the approval flow (see `approvals.ts`) before running.
   * Default: the AI SDK tool's own `needsApproval` — Chat SDK ships its
   * write tools (post, DM, edit, delete, …) gated, and silently ungating
   * them would hand the model destructive tools the vendor considers unsafe.
   * A dynamic vendor predicate counts as gated.
   */
  needsApproval?: boolean;
  /** How long a gated call waits for a decision, in milliseconds. Default 5 minutes. */
  approvalTimeout?: number;
}

/**
 * Wrap an AI SDK tool as a Noetic `Tool`. A gated tool first sends an
 * `ApprovalRequest` on the `approvalRequests` channel and waits for its
 * decision on `approvalDecisions`; a rejection or timeout surfaces to the
 * model as a tool error. Vendor tools are invoked with a synthetic
 * `toolCallId` and are not cancelled mid-flight on turn abort (the harness
 * exposes no abort signal to tool executors).
 */
export function fromAiSdkTool(
  name: string,
  aiTool: AiSdkToolLike,
  options: FromAiSdkToolOptions = {},
): Tool {
  const { execute } = aiTool;
  if (typeof execute !== 'function') {
    throw new Error(`AI SDK tool '${name}' has no execute function and cannot be wrapped.`);
  }
  const input = isZodSchema(aiTool.inputSchema)
    ? frameworkCast<ZodTypeAny>(aiTool.inputSchema)
    : z.unknown();
  const needsApproval = options.needsApproval ?? vendorNeedsApproval(aiTool);
  const timeout = options.approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT;

  return {
    name,
    description: aiTool.description ?? name,
    input,
    output: z.unknown(),
    needsApproval,
    execute: async (args: unknown, toolCtxRaw: unknown): Promise<unknown> => {
      if (needsApproval) {
        const toolCtx = frameworkCast<ToolExecutionContext>(toolCtxRaw);
        await awaitApproval({
          name,
          args,
          toolCtx,
          timeout,
        });
      }
      return await execute(args, {
        toolCallId: crypto.randomUUID(),
        messages: [],
      });
    },
  };
}

export interface ChatToolsOptions {
  /** The `Chat` instance the tools operate on. */
  chat: unknown;
  /** Tool preset name(s) forwarded to `createChatTools` (e.g. `'messenger'`). */
  preset?: string | string[];
  /** Read scope forwarded to `createChatTools`. */
  scope?: unknown;
  /**
   * Gate all tools (`true`), none (`false`), or per-tool
   * (`{ deleteMessage: true }`). Tools not named keep the vendor's own
   * default — Chat SDK gates its write tools.
   */
  requireApproval?: boolean | Record<string, boolean>;
  /** How long a gated call waits for a decision, in milliseconds. Default 5 minutes. */
  approvalTimeout?: number;
}

/**
 * Build Noetic tools from Chat SDK's `createChatTools` (post, DM, react,
 * edit, delete, …). Imports `chat/ai` lazily — `chat` and its `ai` peer are
 * optional peer dependencies, so this fails with a clear error when either
 * is missing. Approval gating runs through the Noetic approval channels, not
 * the AI SDK loop (which never runs here).
 */
export async function chatTools(options: ChatToolsOptions): Promise<Tool[]> {
  const created = (await importChatAi()).createChatTools({
    chat: options.chat,
    preset: options.preset,
    scope: options.scope,
  });
  const tools: Tool[] = [];
  for (const [name, aiTool] of Object.entries(created)) {
    if (!aiTool) {
      continue;
    }
    tools.push(
      fromAiSdkTool(name, aiTool, {
        needsApproval: resolveApprovalFlag(options.requireApproval, name),
        approvalTimeout: options.approvalTimeout,
      }),
    );
  }
  return tools;
}

async function awaitApproval(params: {
  name: string;
  args: unknown;
  toolCtx: ToolExecutionContext;
  timeout: number;
}): Promise<void> {
  const { ctx, harness } = params.toolCtx;
  const requestId = crypto.randomUUID();
  const deadline = Date.now() + params.timeout;

  // Park the receiver BEFORE sending the request: topic delivery is lossy,
  // and the subscription must exist before any decision can possibly arrive.
  let pending = harness.recv(approvalDecisions, ctx, {
    timeout: params.timeout,
  });
  await harness.send(
    approvalRequests,
    {
      requestId,
      toolName: params.name,
      args: params.args,
      threadId: ctx.threadId,
    },
    ctx,
  );

  while (true) {
    const decision = await pending;
    if (decision.requestId === requestId) {
      if (!decision.approved) {
        const reason = decision.reason ? `: ${decision.reason}` : '';
        throw new Error(`Tool call '${params.name}' was rejected by the user${reason}.`);
      }
      return;
    }
    // Another gated call's decision woke us. Re-park immediately — the gap
    // is a microtask, and external sends arrive from I/O macrotasks, so a
    // decision cannot slip through it.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Tool call '${params.name}' timed out waiting for approval.`);
    }
    pending = harness.recv(approvalDecisions, ctx, {
      timeout: remaining,
    });
  }
}

interface ChatAiModule {
  createChatTools(options: Record<string, unknown>): Record<string, AiSdkToolLike | undefined>;
}

async function importChatAi(): Promise<ChatAiModule> {
  try {
    // The mirror type erases chat's generics; the runtime shape matches.
    return frameworkCast<ChatAiModule>(await import('chat/ai'));
  } catch (cause) {
    throw new Error(
      "chatTools() needs the optional peer dependency 'chat' (chat-sdk.dev) and its 'ai' peer. Install them with: npm install chat ai",
      {
        cause,
      },
    );
  }
}

function isZodSchema(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'safeParse' in value;
}

/** A dynamic vendor predicate counts as gated — better a spurious card than an ungated delete. */
function vendorNeedsApproval(aiTool: AiSdkToolLike): boolean {
  return aiTool.needsApproval !== undefined && aiTool.needsApproval !== false;
}

function resolveApprovalFlag(
  requireApproval: boolean | Record<string, boolean> | undefined,
  name: string,
): boolean | undefined {
  if (typeof requireApproval === 'boolean') {
    return requireApproval;
  }
  return requireApproval?.[name];
}
