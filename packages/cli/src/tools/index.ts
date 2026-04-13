/**
 * Tool exports and convenience factories.
 */

import type { FsAdapter, Tool } from '@noetic/core';
import { createLocalFsAdapter } from '@noetic/core';
import { createBashTool } from './bash.js';
import { createEditTool } from './edit.js';
import { createFindTool } from './find.js';
import { createGrepTool } from './grep.js';
import { createLsTool } from './ls.js';
import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';

//#region Re-exports

export {
  type ActivateSkillTool,
  createActivateSkillTool,
} from './activate-skill.js';
export { type BashOperations, type BashOutput, type BashTool, createBashTool } from './bash.js';
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
export { getRiskDescription, isHighRiskCommand, validateCommand } from './security.js';
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

export function createCodingTools(cwd: string, fs: FsAdapter = createLocalFsAdapter()): Tool[] {
  return [
    createReadTool(cwd, fs),
    createWriteTool(cwd, fs),
    createEditTool(cwd, fs),
    createBashTool(cwd),
    createGrepTool(cwd, fs),
    createFindTool(cwd, fs),
    createLsTool(cwd, fs),
  ];
}

export function createReadOnlyTools(cwd: string, fs: FsAdapter = createLocalFsAdapter()): Tool[] {
  return [
    createReadTool(cwd, fs),
    createGrepTool(cwd, fs),
    createFindTool(cwd, fs),
    createLsTool(cwd, fs),
  ];
}

//#endregion
