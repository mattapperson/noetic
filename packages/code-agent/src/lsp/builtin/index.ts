import type { LspServerContribution } from '../types.js';
import { goContribution } from './go.js';
import { pythonContribution } from './python.js';
import { swiftContribution } from './swift.js';
import { typescriptContribution } from './typescript.js';

/**
 * The language-server contributions shipped built-in with `@noetic-tools/cli`.
 * Third-party plugins can contribute additional servers via
 * `NoeticPlugin.lspServers`. Plugin contributions are applied after builtins,
 * so they can override a builtin by reusing its `id`.
 */
export function createBuiltinLspServers(): ReadonlyArray<LspServerContribution> {
  return [
    typescriptContribution,
    pythonContribution,
    goContribution,
    swiftContribution,
  ];
}
