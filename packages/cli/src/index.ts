/**
 * @noetic/cli — Coding agent CLI/TUI package.
 */

export { createClient } from './ai/client.js';
export { buildSystemPrompt } from './ai/system-prompt.js';
export { createCodingTools, createReadOnlyTools } from './tools/index.js';
export { ResponsesChat, type ResponsesChatProps } from './tui/components/index.js';
export type { ConversationEntry, UserEntry } from './tui/item-utils.js';
export type { AgentConfig } from './types/config.js';
