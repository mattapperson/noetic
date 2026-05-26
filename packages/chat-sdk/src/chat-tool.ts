import type { Tool, ToolExecutionContext } from '@noetic-tools/core';
import type { ZodTypeAny, z } from 'zod';

import type { ChatTool, ChatToolRenderable } from './types';

//#region Types

/** @public Configuration for creating a ChatTool. */
export interface ChatToolConfig<I extends ZodTypeAny, O extends ZodTypeAny> {
  /** Unique tool name used by the LLM for selection. */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Zod schema validating tool input arguments. */
  input: I;
  /** Zod schema validating tool return value. */
  output: O;
  /** Async function that performs the tool's work. */
  execute: (args: z.infer<I>, toolCtx: ToolExecutionContext) => Promise<z.infer<O>>;
  /** When true, execution pauses for human approval before running. */
  needsApproval?: boolean;
  /** Render tool output as a chat-sdk card or string for posting after execution. */
  render?: (output: unknown) => ChatToolRenderable;
}

//#endregion

//#region Registry

const chatToolRegistry = new Map<string, ChatTool>();

/** @internal Look up a ChatTool's render function by tool name. */
export function getChatToolRender(
  toolName: string,
): ((output: unknown) => ChatToolRenderable) | undefined {
  return chatToolRegistry.get(toolName)?.render;
}

/** @internal Clear the registry (for testing). */
export function clearChatToolRegistry(): void {
  chatToolRegistry.clear();
}

//#endregion

//#region Public API

/**
 * Create a Noetic Tool with an optional chat-sdk card render function.
 *
 * The returned tool is a standard Noetic Tool usable in `step.llm({ tools: [...] })`.
 * The `render` function is stored in a registry and used by NoeticChat to post
 * rich cards after tool execution completes.
 *
 * @param config - Tool configuration including optional render function
 * @returns A ChatTool (extends Tool) with render capability
 *
 * @public
 */
export function chatTool<I extends ZodTypeAny, O extends ZodTypeAny>(
  config: ChatToolConfig<I, O>,
): ChatTool<I, O> {
  const baseTool: Tool<I, O> = {
    name: config.name,
    description: config.description,
    input: config.input,
    output: config.output,
    execute: config.execute,
    needsApproval: config.needsApproval,
  };

  const ct: ChatTool<I, O> = {
    ...baseTool,
    render: config.render,
  };

  chatToolRegistry.set(config.name, ct);

  return ct;
}

//#endregion
