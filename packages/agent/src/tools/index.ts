/**
 * Tool exports and convenience factories.
 */

import type { Tool } from '@openrouter/sdk';
import { createBashTool } from './bash.js';
import { createEditTool } from './edit.js';
import { createFindTool } from './find.js';
import { createGrepTool } from './grep.js';
import { createLsTool } from './ls.js';
import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';

//#region Re-exports

export { type BashOperations, type BashOutput, type BashTool, createBashTool } from './bash.js';
export { createEditTool, type EditOperations, type EditOutput, type EditTool } from './edit.js';
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
export { createFindTool, type FindOperations, type FindOutput, type FindTool } from './find.js';
export { createGrepTool, type GrepOperations, type GrepOutput, type GrepTool } from './grep.js';
export { createLsTool, type LsOperations, type LsOutput, type LsTool } from './ls.js';
export { expandPath, resolveReadPath, resolveToCwd } from './path-utils.js';
export {
  createReadTool,
  type ReadOperations,
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
  type WriteOperations,
  type WriteOutput,
  type WriteTool,
} from './write.js';

//#endregion

//#region Tool Collection Factories

export function createCodingTools(cwd: string): Tool[] {
  return [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}

export function createReadOnlyTools(cwd: string): Tool[] {
  return [
    createReadTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}

//#endregion
