/**
 * Type definitions for the slash command system.
 *
 * Commands are user-invocable actions that execute locally in the CLI,
 * distinct from skills which are instruction prompts for the model.
 */

import type { AskUserService } from '@noetic/code-agent/ask-user-service';
import type { AgentHarness, LastLayerUsage, MemoryLayer } from '@noetic/core';
import type { ReactNode } from 'react';
import type { SkillDefinition } from '../skills/types.js';
import type { AgentConfig } from '../types/config.js';
import type { ConversationEntry } from '../types/session.js';

//#region Command Context

/**
 * Context passed to command handlers during execution.
 */
interface CommandContext {
  /** Current agent configuration */
  config: AgentConfig;
  /** Current working directory */
  cwd: string;
  /**
   * Active agent harness, when this command is invoked from the chat TUI.
   * Undefined in headless contexts (e.g. tests, the resume picker, or
   * commands invoked before any harness exists). Commands that require
   * the harness MUST guard for `undefined` and degrade gracefully.
   */
  harness?: AgentHarness;
  /**
   * Service for asking the user structured questions via the chat TUI's
   * modal. Undefined outside the chat-TUI context. Commands that require
   * interactive prompts MUST guard for `undefined`.
   */
  askUserService?: AskUserService;
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
  /**
   * A read-only snapshot of session-level metadata the TUI currently tracks.
   * Used by `/session` to print a status report; updated live as turns complete.
   */
  sessionSnapshot: SessionSnapshot;
  /** Set the session's `customTitle`. Applied on the next save. */
  setCustomTitle: (name: string | undefined) => void;
  /** Set the session's `tag`. Applied on the next save. */
  setTag: (tag: string | undefined) => void;
  /**
   * Reset session state and start fresh: new sessionId, empty entries,
   * zero cumulative counters, forget any resumed history. Use by `/clear`
   * and (optionally) by `/resume` when the user cancels the picker.
   */
  clearSession: () => void;
  /**
   * Restart the TUI against a different session, or return a user-facing
   * failure message when the target cannot be resolved. Used by `/resume`.
   */
  restartWithSession: (
    target: SessionRestartTarget,
  ) => Promise<string | undefined> | string | undefined;
  /**
   * Switch the TUI's primary view mode. The chat view ('chat') is the
   * default; 'taskBoard' renders the kanban board fullscreen instead of
   * the chat. Undefined in headless contexts (tests, picker, etc.).
   */
  setViewMode?: (mode: ViewMode) => void;
}

/** Top-level views the TUI can render. */
export type ViewMode =
  | {
      readonly kind: 'chat';
    }
  | {
      readonly kind: 'taskBoard';
    }
  | {
      readonly kind: 'taskChat';
      readonly socketPath: string;
      readonly taskId: string;
      readonly roleLabel: string;
    }
  | {
      readonly kind: 'taskChatSpawning';
      readonly taskId: string;
    };

export interface SessionSnapshot {
  sessionId: string;
  cwd: string;
  effectiveCwd: string;
  model: string;
  createdAt: string;
  customTitle?: string;
  tag?: string;
  firstPrompt: string;
  messageCount: number;
  cumulativeUsage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
  cumulativeCost: number;
  persistenceEnabled: boolean;
}

/** What `restartWithSession` targets: a specific session file, or `null` meaning "open the picker". */
export type SessionRestartTarget =
  | {
      kind: 'file';
      file: import('../types/session.js').SessionFile;
    }
  | {
      kind: 'id';
      sessionId: string;
    }
  | {
      kind: 'picker';
    };

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
    }
  | {
      type: 'prompt';
      value: string;
    };

/**
 * Result a JSX command can hand back to the App when its modal closes.
 *
 * - `string`: posted to chat as an info entry (existing behaviour).
 * - `{ type: 'prompt'; value }`: dismisses the modal and submits `value` as
 *   the next user turn — used by `/diff-review` to send composed feedback to
 *   the agent without an extra round-trip through the prompt input.
 */
type LocalJsxCommandResult =
  | string
  | {
      type: 'prompt';
      value: string;
    };

/**
 * Callback when a JSX command completes.
 */
type LocalJsxCommandOnDone = (result?: LocalJsxCommandResult) => void;

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
 * Result variant produced only by JSX commands — wraps the rendered node plus
 * the metadata the TUI needs to open the modal.
 */
type ModalExecutionResult = {
  type: 'modal';
  node: ReactNode;
  commandName: string;
  dismissMessage: string;
};

/**
 * Result of executing a command. JSX commands may produce a modal; all other
 * results share `LocalCommandResult`'s variants.
 */
type CommandExecutionResult = LocalCommandResult | ModalExecutionResult;

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
  LocalJsxCommandResult,
  ModalExecutionResult,
};
