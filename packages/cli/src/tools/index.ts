/**
 * Tool exports and convenience factories.
 */

import type { FsAdapter, ShellAdapter, Tool } from '@noetic/core';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic/core';
import type { LspService } from '../lsp/service.js';
import type { AskUserService } from '../tui/services/ask-user-service.js';
import { createAskUserTool } from './ask-user.js';
import { createBashTool } from './bash.js';
import { createEditTool } from './edit.js';
import { createFindTool } from './find.js';
import { createGrepTool } from './grep.js';
import { createLsTool } from './ls.js';
import { createLspTool } from './lsp.js';
import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';

//#region Re-exports

export {
  type ActivateSkillTool,
  createActivateSkillTool,
} from './activate-skill.js';
export { createAgentTool } from './agent.js';
export { type AskUserTool, createAskUserTool } from './ask-user.js';
export {
  type AskUserAnnotation,
  AskUserAnnotationSchema,
  type AskUserInput,
  AskUserInputSchema,
  type AskUserOption,
  AskUserOptionSchema,
  type AskUserOutput,
  AskUserOutputSchema,
  type AskUserQuestion,
  AskUserQuestionSchema,
} from './ask-user-types.js';
export { type BashOutput, type BashTool, createBashTool } from './bash.js';
export { createCheckAgentTool } from './check-agent.js';
export { createEditTool, type EditOutput, type EditTool } from './edit.js';
export {
  computeEditDiff,
  detectLineEnding,
  type EditDiffError,
  type EditDiffResult,
  generateDiffString,
  normalizeToLf,
  restoreLineEndings,
  stripBom,
} from './edit-diff.js';
export { createFindTool, type FindOutput, type FindTool } from './find.js';
export { createGrepTool, type GrepOutput, type GrepTool } from './grep.js';
export { createLsTool, type LsOutput, type LsTool } from './ls.js';
export { expandPath, resolveReadPath, resolveToCwd } from './path-utils.js';
export {
  createReadTool,
  type ReadOutput,
  type ReadTool,
} from './read.js';
export {
  getRiskDescription,
  isBannedCommand,
  isHighRiskCommand,
  isInteractiveCommand,
  validateCommand,
} from './security.js';
export { createSendMessageTool } from './send-message.js';
export {
  formatSize,
  type TruncationOptions,
  type TruncationResult,
  truncateHead,
  truncateLine,
  truncateTail,
} from './truncate.js';
export {
  createWriteTool,
  type WriteOutput,
  type WriteTool,
} from './write.js';

//#endregion

//#region Tool Collection Factories

export interface CreateToolsOptions {
  cwd: string;
  fs?: FsAdapter;
  shell?: ShellAdapter;
  lspService?: LspService;
  /**
   * Optional ask-user service, supplied by the TUI. When present, the
   * `AskUserQuestion` tool is registered and can pause mid-turn for human
   * input. Headless harnesses should omit it — asking with no UI would hang.
   */
  askUserService?: AskUserService;
}

export function createCodingTools(opts: CreateToolsOptions): Tool[] {
  const { cwd, lspService, askUserService } = opts;
  const fs = opts.fs ?? createLocalFsAdapter();
  const shell = opts.shell ?? createLocalShellAdapter();
  const tools: Tool[] = [
    createReadTool(cwd, fs),
    createWriteTool(cwd, fs),
    createEditTool(cwd, fs),
    createBashTool(cwd, shell),
    createGrepTool(cwd, fs, shell),
    createFindTool(cwd, fs),
    createLsTool(cwd, fs),
  ];
  if (lspService) {
    tools.push(createLspTool(lspService, cwd));
  }
  if (askUserService) {
    tools.push(createAskUserTool(askUserService));
  }
  return tools;
}

export function createReadOnlyTools(opts: CreateToolsOptions): Tool[] {
  const { cwd, lspService, askUserService } = opts;
  const fs = opts.fs ?? createLocalFsAdapter();
  const shell = opts.shell ?? createLocalShellAdapter();
  const tools: Tool[] = [
    createReadTool(cwd, fs),
    createGrepTool(cwd, fs, shell),
    createFindTool(cwd, fs),
    createLsTool(cwd, fs),
  ];
  if (lspService) {
    tools.push(createLspTool(lspService, cwd));
  }
  if (askUserService) {
    tools.push(createAskUserTool(askUserService));
  }
  return tools;
}

//#endregion
