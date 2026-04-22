/**
 * Commands module - Slash command system for the CLI.
 */

// Built-in commands
export { BUILTIN_COMMANDS, clear, context, skills } from './builtins/index.js';
// Execute
export { executeCommand } from './execute.js';
export type { ParsedSlashCommand } from './parse.js';
// Parse
export {
  isAutoDetectedShellCommand,
  isBashCommand,
  isSlashCommand,
  parseBashCommand,
  parseSlashCommand,
} from './parse.js';
// Registry
export { findCommand, getEnabledCommands, getVisibleCommands, hasCommand } from './registry.js';

// Suggestions
export { commandsToPromptSuggestions, generateCommandSuggestions } from './suggestions.js';
// Types
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
} from './types.js';
