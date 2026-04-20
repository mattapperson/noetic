/**
 * @noetic/cli — Coding agent CLI/TUI package.
 */

export type {
  CallModel,
  CallModelInput,
  CallModelMessage,
  CallModelResponse,
  CallModelRole,
} from './ai/plugin-call-model.js';
export { buildSystemPrompt } from './ai/system-prompt.js';
export type {
  Command,
  CommandBase,
  CommandContext,
  CommandExecutionResult,
  LocalCommand,
  LocalCommandCall,
  LocalCommandModule,
  LocalCommandResult,
  LocalJsxCommand,
  LocalJsxCommandCall,
  LocalJsxCommandModule,
  LocalJsxCommandOnDone,
} from './commands/types.js';
export { discoverConfig, resolvePluginBaseDir } from './config/discovery.js';
export { createAgentHarness, type HarnessWithSkills } from './harness/factory.js';
export { disposePlugins, loadPlugins } from './plugins/loader.js';
export type { FooterContext, NoeticPlugin, PluginContext } from './plugins/types.js';
export { createCodingTools, createReadOnlyTools } from './tools/index.js';
export { ResponsesChat, type ResponsesChatProps } from './tui/components/index.js';
export { FooterContextProvider, useFooterContext } from './tui/footer-context.js';
export type { AssistantEntry, ConversationEntry, UserEntry } from './tui/item-utils.js';
export type { AgentConfig, PluginSpec } from './types/config.js';
