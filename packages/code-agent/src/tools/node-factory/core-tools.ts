import type { FsAdapter, ShellAdapter, Tool } from '@noetic/core';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic/core/adapters/node';
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

export interface CreateToolsOptions {
  cwd: string;
  fs?: FsAdapter;
  shell?: ShellAdapter;
  lspService?: LspService;
  askUserService?: AskUserService;
  mutationPolicy?: MutationPolicy;
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
  return addOptionalTools(
    [
      createReadTool(opts.cwd, fs),
      createWriteTool(opts.cwd, fs, opts.mutationPolicy),
      createEditTool(opts.cwd, fs, opts.mutationPolicy),
      createBashTool(opts.cwd, shell, opts.mutationPolicy),
      createGrepTool(opts.cwd, fs, shell),
      createFindTool(opts.cwd, fs),
      createLsTool(opts.cwd, fs),
      createInteractiveTerminalTool(opts.cwd, shell, {
        mutationPolicy: opts.mutationPolicy,
      }),
      createBrowserTool(opts.cwd, shell),
    ],
    opts,
    opts.lspService,
  );
}

export function createReadOnlyTools(opts: CreateToolsOptions): Tool[] {
  const fs = opts.fs ?? createLocalFsAdapter();
  const shell = opts.shell ?? createLocalShellAdapter();
  return addOptionalTools(
    [
      createReadTool(opts.cwd, fs),
      createGrepTool(opts.cwd, fs, shell),
      createFindTool(opts.cwd, fs),
      createLsTool(opts.cwd, fs),
      createInteractiveTerminalTool(opts.cwd, shell, {
        readonly: true,
        mutationPolicy: opts.mutationPolicy,
      }),
    ],
    opts,
    opts.lspService,
  );
}
