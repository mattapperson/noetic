import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic-tools/platform-node';
import type { FsAdapter, ShellAdapter, Tool } from '@noetic-tools/core';
import type { LspService } from '../../lsp/service.js';
import type { AskUserService } from '../ask-user.js';
import { createAskUserTool } from '../ask-user.js';
import { createBashTool } from '../bash.js';
import { createBrowserTool } from '../browser.js';
import { createEditTool } from '../edit.js';
import { createFindTool } from '../find.js';
import { createGrepTool } from '../grep.js';
import { createInteractiveTerminalTool } from '../interactive-terminal.js';
import { createLsTool } from '../ls.js';
import { createLspTool } from '../lsp.js';
import type { MutationPolicy } from '../mutation-policy.js';
import { createReadTool } from '../read.js';
import { createWriteTool } from '../write.js';

/**
 * Per-tool availability flags. Defaults to every tool enabled so existing
 * callers see no behaviour change; the CLI setup flow passes an explicit
 * map when the user has ignored the binary that backs a tool.
 */
export interface AvailableTools {
  /** When `false`, `InteractiveTerminal` (pilotty-backed) is omitted. */
  interactiveTerminal?: boolean;
  /** When `false`, the `browser` tool (agent-browser-backed) is omitted. */
  browser?: boolean;
}

export interface CreateToolsOptions {
  cwd: string;
  fs?: FsAdapter;
  shell?: ShellAdapter;
  lspService?: LspService;
  askUserService?: AskUserService;
  mutationPolicy?: MutationPolicy;
  /**
   * Gate tools whose external binary may be missing/ignored. Unset flags
   * default to `true` — the tool is registered — so this is purely an
   * opt-out layer.
   */
  availableTools?: AvailableTools;
}

function isEnabled(flag: boolean | undefined): boolean {
  return flag !== false;
}

function addOptionalTools(
  tools: Tool[],
  opts: CreateToolsOptions,
  lspService: LspService | undefined,
): Tool[] {
  if (lspService) {
    tools.push(createLspTool(lspService, opts.cwd));
  }
  if (opts.askUserService) {
    tools.push(createAskUserTool(opts.askUserService));
  }
  return tools;
}

export function createCodingTools(opts: CreateToolsOptions): Tool[] {
  const fs = opts.fs ?? createLocalFsAdapter();
  const shell = opts.shell ?? createLocalShellAdapter();
  const available = opts.availableTools ?? {};
  const tools: Tool[] = [
    createReadTool(opts.cwd, fs),
    createWriteTool(opts.cwd, fs, opts.mutationPolicy),
    createEditTool(opts.cwd, fs, opts.mutationPolicy),
    createBashTool(opts.cwd, shell, opts.mutationPolicy),
    createGrepTool(opts.cwd, fs, shell),
    createFindTool(opts.cwd, fs),
    createLsTool(opts.cwd, fs),
  ];
  if (isEnabled(available.interactiveTerminal)) {
    tools.push(
      createInteractiveTerminalTool(opts.cwd, shell, {
        mutationPolicy: opts.mutationPolicy,
      }),
    );
  }
  if (isEnabled(available.browser)) {
    tools.push(createBrowserTool(opts.cwd, shell));
  }
  return addOptionalTools(tools, opts, opts.lspService);
}

export function createReadOnlyTools(opts: CreateToolsOptions): Tool[] {
  const fs = opts.fs ?? createLocalFsAdapter();
  const shell = opts.shell ?? createLocalShellAdapter();
  const available = opts.availableTools ?? {};
  const tools: Tool[] = [
    createReadTool(opts.cwd, fs),
    createGrepTool(opts.cwd, fs, shell),
    createFindTool(opts.cwd, fs),
    createLsTool(opts.cwd, fs),
  ];
  if (isEnabled(available.interactiveTerminal)) {
    tools.push(
      createInteractiveTerminalTool(opts.cwd, shell, {
        readonly: true,
        mutationPolicy: opts.mutationPolicy,
      }),
    );
  }
  return addOptionalTools(tools, opts, opts.lspService);
}
