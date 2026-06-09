/**
 * Environment context memory layer — dynamic environment awareness.
 *
 * Provides context about the working environment, platform, and runtime
 * capabilities. Similar to Claude Code's environment detection but
 * managed through the memory layer system.
 *
 * Environment detection is LAZY: performed on the first recall() call
 * rather than at init() time, so harness creation (which awaits memory
 * init for all layers) is fast. The detected info is cached in state
 * and persisted across turns by the framework's store mechanism.
 *
 * Budget respect: recall() estimates the output token count using
 * ctx.tokenize. If it exceeds the budget param, lower-priority
 * sections ("Available Commands" list, then "Platform Notes") are
 * dropped until the output fits.
 */

import type { FsAdapter, MemoryLayer, RecallParams, ShellAdapter } from '@noetic-tools/core';
import { Slot } from '@noetic-tools/core';

import type { AgentConfig } from '../types/config.js';

//#region Types

interface EnvironmentInfo {
  platform: NodeJS.Platform;
  cwd: string;
  isGitRepo: boolean;
  gitBranch?: string;
  nodeVersion: string;
  shellType?: string;
  availableCommands: string[];
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
}

interface EnvironmentContextState {
  environment: EnvironmentInfo | null;
  lastUpdate: number;
  capabilities: string[];
}

interface EnvironmentContextConfig {
  config: AgentConfig;
  shell: ShellAdapter;
}

//#endregion

//#region Helpers

async function detectGitRepository(
  shell: ShellAdapter,
  cwd: string,
): Promise<{
  isRepo: boolean;
  branch?: string;
}> {
  try {
    const result = await shell.exec('git rev-parse --is-inside-work-tree', {
      cwd,
      timeout: 5,
    });

    if (result.exitCode === 0) {
      const branchResult = await shell.exec('git branch --show-current', {
        cwd,
        timeout: 5,
      });

      return {
        isRepo: true,
        branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined,
      };
    }
  } catch {
    // Git not available or not a repo
  }

  return {
    isRepo: false,
  };
}

async function detectNodeVersion(shell: ShellAdapter, cwd: string): Promise<string> {
  try {
    const result = await shell.exec('node --version', {
      cwd,
      timeout: 5,
    });
    return result.exitCode === 0 ? result.stdout.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function detectShellType(shell: ShellAdapter, cwd: string): Promise<string> {
  try {
    const result = await shell.exec('echo $SHELL', {
      cwd,
      timeout: 3,
    });
    if (result.exitCode === 0) {
      const shellPath = result.stdout.trim();
      if (shellPath.includes('zsh')) {
        return 'zsh';
      }
      if (shellPath.includes('bash')) {
        return 'bash';
      }
      if (shellPath.includes('fish')) {
        return 'fish';
      }
      return shellPath.split('/').pop() || 'unknown';
    }
  } catch {
    // Fallback detection methods could go here
  }

  return 'unknown';
}

async function detectPackageManager(
  fs: FsAdapter,
  cwd: string,
): Promise<'npm' | 'yarn' | 'pnpm' | 'bun' | undefined> {
  // Use fs adapter for file-existence checks (more reliable than shelling out).
  const checkFile = async (filename: string): Promise<boolean> => {
    const absPath = `${cwd}/${filename}`;
    try {
      await fs.readFile(absPath);
      return true;
    } catch {
      return false;
    }
  };

  // Run all lock file checks in parallel for speed
  const lockFiles = [
    'bun.lockb',
    'pnpm-lock.yaml',
    'yarn.lock',
    'package-lock.json',
    'package.json',
  ];
  const results = await Promise.all(lockFiles.map((ext) => checkFile(ext)));

  const [hasBun, hasPnpm, hasYarn, hasNpm, hasPackageJson] = results;

  // Check for lock files (most reliable indicator), returning first match
  if (hasBun) {
    return 'bun';
  }
  if (hasPnpm) {
    return 'pnpm';
  }
  if (hasYarn) {
    return 'yarn';
  }
  if (hasNpm) {
    return 'npm';
  }
  if (hasPackageJson) {
    return 'npm';
  }

  return undefined;
}

async function detectAvailableCommands(shell: ShellAdapter, cwd: string): Promise<string[]> {
  const commonCommands = [
    'git',
    'npm',
    'yarn',
    'pnpm',
    'bun',
    'curl',
    'wget',
    'jq',
    'docker',
  ];
  const available: string[] = [];

  // Check commands in parallel with timeout
  const checks = commonCommands.map(async (cmd) => {
    try {
      const result = await shell.exec(`command -v ${cmd}`, {
        cwd,
        timeout: 2,
      });
      return result.exitCode === 0 ? cmd : null;
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(checks);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      available.push(result.value);
    }
  }

  return available;
}

async function gatherEnvironmentInfo(
  shell: ShellAdapter,
  fs: FsAdapter,
  cwd: string,
): Promise<EnvironmentInfo> {
  const [gitInfo, nodeVersion, shellType, packageManager, availableCommands] = await Promise.all([
    detectGitRepository(shell, cwd),
    detectNodeVersion(shell, cwd),
    detectShellType(shell, cwd),
    detectPackageManager(fs, cwd),
    detectAvailableCommands(shell, cwd),
  ]);

  return {
    platform: process.platform,
    cwd,
    isGitRepo: gitInfo.isRepo,
    gitBranch: gitInfo.branch,
    nodeVersion,
    shellType,
    availableCommands,
    packageManager,
  };
}

function getPlatformSpecificNotes(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32':
      return `## Platform Notes
- **Windows**: Use Unix-style paths in commands (forward slashes)
- **Paths**: Use /dev/null not NUL for null device
- **Commands**: Unix shell syntax expected, not Windows batch`;

    case 'darwin':
      return `## Platform Notes
- **macOS**: Standard Unix environment
- **Commands**: Full bash/zsh command support
- **Paths**: Case-sensitive filesystem`;

    default:
      return `## Platform Notes
- **${platform}**: Unix-like environment
- **Commands**: Standard Unix shell commands available
- **Paths**: Use forward slashes for paths`;
  }
}

function determineCapabilities(env: EnvironmentInfo): string[] {
  const capabilities: string[] = [];

  if (env.isGitRepo) {
    capabilities.push('Git version control');
  }

  if (env.packageManager) {
    capabilities.push(`${env.packageManager} package management`);
  }

  if (env.availableCommands.includes('docker')) {
    capabilities.push('Docker containerization');
  }

  if (env.availableCommands.includes('curl') || env.availableCommands.includes('wget')) {
    capabilities.push('HTTP requests');
  }

  if (env.availableCommands.includes('jq')) {
    capabilities.push('JSON processing');
  }

  return capabilities;
}

/**
 * Stable identifier for each context section, used to derive a deterministic
 * drop order under budget pressure independent of which optional sections are
 * present in the list. Core kinds (WorkingEnvironment, Git, PackageManagement)
 * are never dropped; only AvailableCommands and PlatformNotes are droppable.
 */
const SectionKind = {
  WorkingEnvironment: 'working-environment',
  Git: 'git',
  PackageManagement: 'package-management',
  AvailableCommands: 'available-commands',
  PlatformNotes: 'platform-notes',
} as const;
type SectionKind = (typeof SectionKind)[keyof typeof SectionKind];

interface ContextSection {
  kind: SectionKind;
  content: string;
}

/**
 * Drop order under budget pressure, lowest-priority first.
 * AvailableCommands is dropped before PlatformNotes. Kinds not listed
 * here (the core sections) are never dropped.
 */
const DROP_ORDER: SectionKind[] = [
  SectionKind.AvailableCommands,
  SectionKind.PlatformNotes,
];

/**
 * Build the context sections array from environment info.
 * Returns tagged sections in priority order (highest first).
 */
function buildContextSections(env: EnvironmentInfo): ContextSection[] {
  const sections: ContextSection[] = [];

  // Working Environment (highest priority — always kept)
  sections.push({
    kind: SectionKind.WorkingEnvironment,
    content: `# Environment Context

## Working Environment
- **Directory**: ${env.cwd}
- **Platform**: ${env.platform}
- **Node.js**: ${env.nodeVersion}
- **Shell**: ${env.shellType || 'unknown'}`,
  });

  // Git Repository (always kept)
  if (env.isGitRepo) {
    sections.push({
      kind: SectionKind.Git,
      content: `## Git Repository
- **Status**: Active repository
- **Current branch**: ${env.gitBranch || 'unknown'}
- **Git operations**: Full git workflow available`,
    });
  } else {
    sections.push({
      kind: SectionKind.Git,
      content: `## Git Repository
- **Status**: Not a git repository
- **Note**: Git operations not applicable in this directory`,
    });
  }

  // Package Management (always kept when present)
  if (env.packageManager) {
    sections.push({
      kind: SectionKind.PackageManagement,
      content: `## Package Management
- **Package manager**: ${env.packageManager}
- **Available commands**: ${
        env.availableCommands
          .filter((cmd) =>
            [
              'npm',
              'yarn',
              'pnpm',
              'bun',
            ].includes(cmd),
          )
          .join(', ') || 'none detected'
      }`,
    });
  }

  // Available Commands (lower priority — dropped first under budget pressure)
  if (env.availableCommands.length > 0) {
    sections.push({
      kind: SectionKind.AvailableCommands,
      content: `## Available Commands
${env.availableCommands.map((cmd) => `- ${cmd}`).join('\n')}`,
    });
  }

  // Platform Notes (lowest priority — dropped second under budget pressure)
  sections.push({
    kind: SectionKind.PlatformNotes,
    content: getPlatformSpecificNotes(env.platform),
  });

  return sections;
}

function joinSections(sections: ContextSection[]): string {
  return sections.map((s) => s.content).join('\n\n');
}

/**
 * Trim sections from the formatted context to fit within budget.
 * Drop order is derived from each section's stable `kind` (see DROP_ORDER),
 * not from positional indices — so it stays correct when optional sections
 * (e.g. Package Management) are absent. Core sections are always kept.
 */
function trimToBudget(opts: {
  sections: ContextSection[];
  budget: number;
  tokenize: (text: string) => number;
}): string {
  let trimmed = [
    ...opts.sections,
  ];

  if (opts.tokenize(joinSections(trimmed)) <= opts.budget) {
    return joinSections(trimmed);
  }

  for (const kind of DROP_ORDER) {
    const candidate = trimmed.filter((s) => s.kind !== kind);
    if (candidate.length === trimmed.length) {
      continue; // Section of this kind not present
    }
    trimmed = candidate;
    if (opts.tokenize(joinSections(trimmed)) <= opts.budget) {
      break; // Now fits
    }
  }

  return joinSections(trimmed);
}

//#endregion

//#region Public API

export function environmentContextLayer(
  config: EnvironmentContextConfig,
): MemoryLayer<EnvironmentContextState> {
  const { config: agentConfig, shell } = config;

  return {
    id: 'environment-context',
    name: 'Environment Context',
    slot: Slot.OBSERVATIONS,
    scope: 'execution',
    budget: {
      min: 200,
      max: 800,
    },

    hooks: {
      /**
       * init() returns immediately with a null environment.
       * Actual detection happens lazily on first recall() so harness creation is fast.
       */
      async init() {
        return {
          state: {
            environment: null,
            lastUpdate: 0,
            capabilities: [],
          },
        };
      },

      async recall({ state, budget, ctx }: RecallParams<EnvironmentContextState>) {
        // Lazily gather environment info on first recall, caching in state
        if (state.environment === null) {
          const envInfo = await gatherEnvironmentInfo(shell, ctx.fs, agentConfig.cwd);
          const capabilities = determineCapabilities(envInfo);
          // Update state in the store via returned state so framework persists it
          state.environment = envInfo;
          state.capabilities = capabilities;
          state.lastUpdate = Date.now();
        }

        const sections = buildContextSections(state.environment);

        return trimToBudget({
          sections,
          budget,
          tokenize: ctx.tokenize,
        });
      },

      // Environment context is mostly static, but we could add periodic refresh
      async store({ state }) {
        // Could implement periodic refresh of environment info here
        // For now, environment is considered static after initialization
        return {
          state,
        };
      },

      async onSpawn({ parentState }) {
        // Children inherit the same environment context
        return {
          childState: {
            ...parentState,
            lastUpdate: Date.now(), // Update timestamp for spawned context
          },
        };
      },
    },
  };
}

//#endregion
