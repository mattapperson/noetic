/**
 * Environment context memory layer — dynamic environment awareness.
 *
 * Provides context about the working environment, platform, and runtime
 * capabilities. Similar to Claude Code's environment detection but
 * managed through the memory layer system.
 */

import type { MemoryLayer, ShellAdapter } from '@noetic/core';
import { Slot } from '@noetic/core';

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
  environment: EnvironmentInfo;
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
      // Try to get current branch
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
    // Try to detect shell from environment
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
  shell: ShellAdapter,
  cwd: string,
): Promise<'npm' | 'yarn' | 'pnpm' | 'bun' | undefined> {
  const checkFile = async (filename: string): Promise<boolean> => {
    try {
      const result = await shell.exec(`test -f "${filename}"`, {
        cwd,
        timeout: 3,
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  };

  // Check for lock files (most reliable indicator)
  if (await checkFile('bun.lockb')) {
    return 'bun';
  }
  if (await checkFile('pnpm-lock.yaml')) {
    return 'pnpm';
  }
  if (await checkFile('yarn.lock')) {
    return 'yarn';
  }
  if (await checkFile('package-lock.json')) {
    return 'npm';
  }

  // If package.json exists but no lock file, default to npm
  if (await checkFile('package.json')) {
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
  config: AgentConfig,
  shell: ShellAdapter,
): Promise<EnvironmentInfo> {
  const [gitInfo, nodeVersion, shellType, packageManager, availableCommands] = await Promise.all([
    detectGitRepository(shell, config.cwd),
    detectNodeVersion(shell, config.cwd),
    detectShellType(shell, config.cwd),
    detectPackageManager(shell, config.cwd),
    detectAvailableCommands(shell, config.cwd),
  ]);

  return {
    platform: process.platform,
    cwd: config.cwd,
    isGitRepo: gitInfo.isRepo,
    gitBranch: gitInfo.branch,
    nodeVersion,
    shellType,
    availableCommands,
    packageManager,
  };
}

function formatEnvironmentContext(env: EnvironmentInfo): string {
  const sections: string[] = [];

  // Basic environment info
  sections.push(`# Environment Context

## Working Environment
- **Directory**: ${env.cwd}
- **Platform**: ${env.platform}
- **Node.js**: ${env.nodeVersion}
- **Shell**: ${env.shellType || 'unknown'}`);

  // Git information
  if (env.isGitRepo) {
    sections.push(`## Git Repository
- **Status**: Active repository
- **Current branch**: ${env.gitBranch || 'unknown'}
- **Git operations**: Full git workflow available`);
  } else {
    sections.push(`## Git Repository
- **Status**: Not a git repository
- **Note**: Git operations not applicable in this directory`);
  }

  // Package management
  if (env.packageManager) {
    sections.push(`## Package Management
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
    }`);
  }

  // Available tooling
  if (env.availableCommands.length > 0) {
    sections.push(`## Available Commands
${env.availableCommands.map((cmd) => `- ${cmd}`).join('\n')}`);
  }

  // Platform-specific notes
  sections.push(getPlatformSpecificNotes(env.platform));

  return sections.join('\n\n');
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

//#endregion

//#region Public API

export function environmentContextLayer(
  config: EnvironmentContextConfig,
): MemoryLayer<EnvironmentContextState> {
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
      async init() {
        const environment = await gatherEnvironmentInfo(config.config, config.shell);
        const capabilities = determineCapabilities(environment);

        return {
          state: {
            environment,
            lastUpdate: Date.now(),
            capabilities,
          },
        };
      },

      async recall({ state }) {
        return formatEnvironmentContext(state.environment);
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
