/**
 * @noetic/agent — Coding agent CLI/TUI package.
 */

export { createClient } from './ai/client.js';
export { createStreamAdapter, type StreamAdapter } from './ai/stream-adapter.js';
export { buildSystemPrompt } from './ai/system-prompt.js';
export { createCodingTools, createReadOnlyTools } from './tools/index.js';
export {
  type AgentState,
  type ChatMessage,
  ChatStatus,
  type ToolCallDisplay,
} from './types/chat.js';
export type { AgentConfig } from './types/config.js';
