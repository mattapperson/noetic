/**
 * @noetic/cli — Coding agent CLI/TUI package.
 */

export { buildSystemPrompt } from './ai/system-prompt.js';
export { discoverConfig, resolvePluginBaseDir } from './config/discovery.js';
export { createAgentHarness, type HarnessWithSkills } from './harness/factory.js';
export { disposePlugins, loadPlugins } from './plugins/loader.js';
export type { FooterContext, NoeticPlugin } from './plugins/types.js';
export { createCodingTools, createReadOnlyTools } from './tools/index.js';
export { ResponsesChat, type ResponsesChatProps } from './tui/components/index.js';
export { FooterContextProvider, useFooterContext } from './tui/footer-context.js';
export type { AssistantEntry, ConversationEntry, UserEntry } from './tui/item-utils.js';
export type { AgentConfig, PluginSpec } from './types/config.js';
