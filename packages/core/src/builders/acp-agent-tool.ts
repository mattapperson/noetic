/**
 * Exposes an ACP coding agent as a `Tool`, so a `callModel` step can delegate
 * work to it by calling it.
 *
 * `step.acpAgent` puts the agent in the step tree, where the *author* decides
 * when it runs. This puts it in the model's hands instead: the model decides
 * that a task wants a coding agent and calls the tool, the same way it would
 * call any other. Everything else — permissions, session policy, the event
 * bridge, usage accounting — is identical, because the tool runs the very same
 * step underneath.
 */

import type {
  AcpAgent,
  AcpClientCapabilityConfig,
  AcpMcpServer,
  AcpPermissionHandler,
  AcpPermissionPolicy,
  AcpSessionPolicy,
  ContextData,
  Tool,
} from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { step } from './step-builders';
import { tool } from './tool-builder';

//#region Types

/** @public Options for {@link acpAgentTool}. */
export interface AcpAgentToolOptions {
  /** The ACP agent adapter to delegate to, e.g. `claudeCode()`. */
  agent: AcpAgent;
  /**
   * Tool name the model calls. Defaults to `delegate_to_<agentId>` with
   * non-identifier characters replaced, e.g. `delegate_to_claude_code`.
   */
  name?: string;
  /**
   * What the model is told the tool does. Defaults to a generic description —
   * override it to steer *when* the model delegates, which matters far more
   * than the default wording.
   */
  description?: string;
  /** Working directory for the agent's session. Defaults to the runtime cwd. */
  cwd?: string;
  /** Session mode to switch to before each delegated turn. */
  mode?: string;
  /** Model to select before each delegated turn. */
  model?: string;
  /** MCP servers to expose to the agent. */
  mcpServers?: ReadonlyArray<AcpMcpServer>;
  /** Declarative answer to the agent's permission requests. Defaults to denying. */
  permissions?: AcpPermissionPolicy;
  /** Async resolver consulted when policy and steering both abstain. */
  onPermissionRequest?: AcpPermissionHandler;
  /** Which client capabilities to advertise to the agent. */
  clientCapabilities?: AcpClientCapabilityConfig;
  /**
   * Session policy for the delegated turns. Give it a `reuse` key with
   * `keepAlive: 'run'` (or `'harness'`) to let the model hold a *conversation*
   * with the agent across several tool calls instead of starting cold each
   * time — usually what you want, since the second call almost always builds
   * on the first.
   */
  session?: AcpSessionPolicy;
}

const AcpAgentToolInputSchema = z.object({
  prompt: z.string().min(1).describe('What the coding agent should do, in plain language.'),
});

const AcpAgentToolOutputSchema = z.object({
  text: z.string().describe("The coding agent's final response."),
});

//#endregion

//#region Helpers

/** `claude-code` → `delegate_to_claude_code`. */
function defaultToolName(agentId: string): string {
  return `delegate_to_${agentId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function defaultDescription(agentId: string): string {
  return [
    `Delegate a coding task to the ${agentId} agent, which works directly in the workspace.`,
    'Give it a complete, self-contained instruction — it does not see this conversation.',
    'Prefer it for multi-file edits, running builds or tests, and exploring an unfamiliar codebase.',
  ].join(' ');
}

//#endregion

//#region Public API

/**
 * Build a {@link Tool} that hands a prompt to an ACP coding agent.
 *
 * @public
 * @param opts.agent - The agent adapter, e.g. `claudeCode()` from `@noetic-tools/acp`.
 * @returns A `Tool` accepting `{ prompt }` and returning `{ text }`.
 * @throws `NoeticConfigError` `MISSING_ACP_AGENT` when no adapter is given.
 */
export function acpAgentTool(
  opts: AcpAgentToolOptions,
): Tool<typeof AcpAgentToolInputSchema, typeof AcpAgentToolOutputSchema> {
  if (!opts.agent) {
    throw new NoeticConfigError({
      code: 'MISSING_ACP_AGENT',
      message: 'acpAgentTool() requires an agent adapter.',
      hint: 'Pass an agent factory result, e.g. agent: claudeCode() from @noetic-tools/acp.',
    });
  }
  const name = opts.name ?? defaultToolName(opts.agent.agentId);

  // Built once, not per call: `step.acpAgent` registers itself in the step
  // registry, so constructing one per invocation would fill the registry with
  // duplicate ids. An empty `prompt` means "use the step's runtime input",
  // which is exactly the tool's argument.
  const delegated = step.acpAgent<ContextData, string, string>({
    id: `${name}:step`,
    agent: opts.agent,
    prompt: '',
    cwd: opts.cwd,
    mode: opts.mode,
    model: opts.model,
    mcpServers: opts.mcpServers,
    permissions: opts.permissions,
    onPermissionRequest: opts.onPermissionRequest,
    clientCapabilities: opts.clientCapabilities,
    session: opts.session,
  });

  return tool({
    name,
    description: opts.description ?? defaultDescription(opts.agent.agentId),
    input: AcpAgentToolInputSchema,
    output: AcpAgentToolOutputSchema,
    async execute(args, toolCtx) {
      // Running through the harness on the tool's own context means the
      // delegated turn lands in the same item log, usage totals, and event
      // stream as any other step — it is a real step, not a side channel.
      const text = await toolCtx.harness.run(delegated, args.prompt, toolCtx.ctx);
      return {
        text,
      };
    },
  });
}

//#endregion
