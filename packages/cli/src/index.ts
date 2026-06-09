/**
 * @noetic-tools/cli — Coding agent CLI/TUI package.
 */

export type {
  ChannelController,
  ChannelTransportAdapter,
  CodeAgent,
  CodeAgentAdapters,
  CodeAgentModelAdapter,
  CodeAgentParams,
  CodeAgentPlugin,
  CodeAgentPluginContext,
  CodeAgentSessionSnapshot,
  CodeAgentSkill,
  CodeAgentTask,
  CodeAgentTaskStatus,
  CodingToolsPluginOptions,
  CreateCodeAgentOptions,
  CreateCodeAgentTaskInput,
  SkillController,
  SubagentController,
  TaskController,
  TaskStoreAdapter,
  ToolController,
} from '@noetic-tools/code-agent';
export {
  createCodeAgent,
  createCodingToolsPlugin,
  createInMemoryChannelTransportAdapter,
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
  createInMemoryTaskStoreAdapter,
  createTaskToolsPlugin,
} from '@noetic-tools/code-agent';
export {
  createAgentTool,
  createCodingTools,
  createReadOnlyTools,
} from '@noetic-tools/code-agent/tools/node';
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
export { ResponsesChat, type ResponsesChatProps } from './tui/components/responses-chat.js';
export { FooterContextProvider, useFooterContext } from './tui/footer-context.js';
export type { AssistantEntry, ConversationEntry, UserEntry } from './tui/item-utils.js';
export {
  type ReattachLiveResult,
  reattachLiveChildren,
} from './tui/reattach-live-children.js';
export type { AgentConfig, PluginSpec } from './types/config.js';
