/**
 * Type definitions for the slash command system.
 *
 * Commands are user-invocable actions that execute locally in the CLI,
 * distinct from skills which are instruction prompts for the model.
 */

import type { LastLayerUsage, MemoryLayer } from '@noetic/core';
import type { ReactNode } from 'react';

import type { SkillDefinition } from '../skills/types.js';
import type { ConversationEntry } from '../tui/item-utils.js';
import type { AgentConfig } from '../types/config.js';

//#region Command Context

/**
 * Context passed to command handlers during execution.
 */
interface CommandContext {
  /** Current agent configuration */
  config: AgentConfig;
  /** Current working directory */
  cwd: string;
  /** Current conversation history */
  entries: ReadonlyArray<ConversationEntry>;
  /** All discovered skills */
  skills: ReadonlyArray<SkillDefinition>;
  /** Names of currently activated skills (from conversation history) */
  activatedSkills: ReadonlySet<string>;
  /** All available commands */
  commands: ReadonlyArray<Command>;
  /** Clear conversation history */
  clearEntries: () => void;
  /** Per-memory-layer breakdown captured after the most recent agent run (undefined before the first run completes). */
  lastLayerUsage?: LastLayerUsage;
  /** Memory layers registered with the harness — includes layers that did not contribute on the last run. */
  memoryLayers: ReadonlyArray<MemoryLayer>;
  /** Current agent mode. */
  agentMode: 'normal' | 'planning';
  /**
   * Switch the active agent mode. Triggers harness recreation so the model
   * sees the correct toolset (full vs read-only) on the next turn.
   */
  setAgentMode: (mode: 'normal' | 'planning') => Promise<void>;
  /**
   * Switch the active LLM to the given OpenRouter model slug (e.g.
   * `anthropic/claude-sonnet-4`). Triggers harness recreation so the next
   * turn runs against the new model.
   */
  setModel: (model: string) => Promise<void>;
}

//#endregion

//#region Command Results

/**
 * Result from a local (non-JSX) command.
 */
type LocalCommandResult =
  | {
      type: 'text';
      value: string;
    }
  | {
      type: 'skip';
    };

/**
 * Callback when a JSX command completes.
 */
type LocalJsxCommandOnDone = (result?: string) => void;

/**
 * Call signature for a local command implementation.
 */
type LocalCommandCall = (args: string, ctx: CommandContext) => Promise<LocalCommandResult>;

/**
 * Module shape returned by load() for lazy-loaded local commands.
 */
interface LocalCommandModule {
  call: LocalCommandCall;
}

/**
 * Call signature for a local JSX command implementation.
 */
type LocalJsxCommandCall = (
  onDone: LocalJsxCommandOnDone,
  ctx: CommandContext,
  args: string,
) => Promise<ReactNode>;

/**
 * Module shape returned by load() for lazy-loaded JSX commands.
 */
interface LocalJsxCommandModule {
  call: LocalJsxCommandCall;
}

//#endregion

//#region Command Types

/**
 * A local command that returns text or skips output.
 */
type LocalCommand = {
  type: 'local';
  load: () => Promise<LocalCommandModule>;
};

/**
 * A local command that renders React/Ink UI.
 */
type LocalJsxCommand = {
  type: 'local-jsx';
  load: () => Promise<LocalJsxCommandModule>;
};

/**
 * Base properties shared by all commands.
 */
interface CommandBase {
  /** Unique command name (without leading slash) */
  name: string;
  /** Alternative names for this command */
  aliases?: ReadonlyArray<string>;
  /** Brief description shown in help */
  description: string;
  /** Whether command is currently enabled */
  isEnabled?: () => boolean;
  /** Whether to hide from autocomplete/help */
  isHidden?: boolean;
}

/**
 * A slash command definition.
 */
type Command = CommandBase & (LocalCommand | LocalJsxCommand);

//#endregion

//#region Execution Result

/**
 * Result of executing a command.
 */
type CommandExecutionResult =
  | {
      type: 'text';
      value: string;
    }
  | {
      type: 'skip';
    }
  | {
      type: 'modal';
      node: ReactNode;
      commandName: string;
      dismissMessage: string;
    };

//#endregion

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
};
