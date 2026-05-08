/**
 * Declarative manifest of the binaries the CLI depends on.
 *
 * Each entry says: how to detect it, what to install with on each OS, what to
 * tell the user if they want to install manually, and which tools to gate
 * when the user chooses to ignore it.
 */

import { detectAgentBrowser, detectPilotty, detectRtk } from './detectors.js';
import type { BinaryDescriptor, InstallOption, OsKind, PackageManager } from './types.js';
import { findWorkspaceRoot } from './workspace-root.js';

//#region rtk

const RTK_CURL_SCRIPT =
  'curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh';

function rtkInstallOptions(
  os: OsKind,
  pms: ReadonlyArray<PackageManager>,
): ReadonlyArray<InstallOption> {
  const options: InstallOption[] = [];

  if (pms.includes('brew') && (os === 'macos' || os === 'linux')) {
    options.push({
      label: 'Homebrew',
      command: 'brew',
      args: [
        'install',
        'rtk-ai/rtk/rtk',
      ],
      requiresPackageManager: 'brew',
    });
  }

  if (pms.includes('cargo') && (os === 'macos' || os === 'linux')) {
    options.push({
      label: 'cargo',
      command: 'cargo',
      args: [
        'install',
        '--git',
        'https://github.com/rtk-ai/rtk',
      ],
      requiresPackageManager: 'cargo',
    });
  }

  if (pms.includes('curl') && (os === 'macos' || os === 'linux')) {
    options.push({
      label: 'curl install script',
      command: 'sh',
      args: [
        '-c',
        RTK_CURL_SCRIPT,
      ],
      requiresPackageManager: 'curl',
    });
  }

  return options;
}

function rtkManualInstructions(os: OsKind): string {
  if (os === 'macos') {
    return [
      'Install rtk with one of:',
      '  brew install rtk-ai/rtk/rtk',
      `  ${RTK_CURL_SCRIPT}`,
      '  cargo install --git https://github.com/rtk-ai/rtk',
    ].join('\n');
  }
  if (os === 'linux') {
    return [
      'Install rtk with one of:',
      `  ${RTK_CURL_SCRIPT}`,
      '  cargo install --git https://github.com/rtk-ai/rtk',
      '  brew install rtk-ai/rtk/rtk   (if you have Homebrew on Linux)',
    ].join('\n');
  }
  if (os === 'windows') {
    return [
      'Install rtk on Windows:',
      '  Download a release from https://github.com/rtk-ai/rtk/releases',
      '  or: scoop install rtk   (if you use scoop)',
    ].join('\n');
  }
  return [
    'Install rtk: https://github.com/rtk-ai/rtk',
    `  ${RTK_CURL_SCRIPT}`,
  ].join('\n');
}

//#endregion

//#region Workspace deps (pilotty + agent-browser)

function bunInstallOption(): InstallOption {
  const root = findWorkspaceRoot(process.cwd()) ?? process.cwd();
  return {
    label: 'bun install (workspace)',
    command: 'bun',
    args: [
      'install',
    ],
    requiresPackageManager: 'bun',
    cwd: root,
  };
}

function pilottyInstallOptions(
  _os: OsKind,
  pms: ReadonlyArray<PackageManager>,
): ReadonlyArray<InstallOption> {
  if (!pms.includes('bun')) {
    return [];
  }
  return [
    bunInstallOption(),
  ];
}

function pilottyManualInstructions(_os: OsKind): string {
  const root = findWorkspaceRoot(process.cwd()) ?? process.cwd();
  return [
    'pilotty is a workspace dependency — install it with:',
    `  cd ${root} && bun install`,
    '',
    'If it is still missing after that, check that packages/cli/package.json lists pilotty as a dependency.',
  ].join('\n');
}

function agentBrowserInstallOptions(
  _os: OsKind,
  pms: ReadonlyArray<PackageManager>,
): ReadonlyArray<InstallOption> {
  const options: InstallOption[] = [];
  const root = findWorkspaceRoot(process.cwd()) ?? process.cwd();

  if (pms.includes('bun')) {
    options.push(bunInstallOption());
  }
  if (pms.includes('bunx')) {
    options.push({
      label: 'bunx agent-browser install (download Chrome)',
      command: 'bunx',
      args: [
        'agent-browser',
        'install',
      ],
      requiresPackageManager: 'bunx',
      cwd: root,
    });
  }

  return options;
}

function agentBrowserManualInstructions(_os: OsKind): string {
  const root = findWorkspaceRoot(process.cwd()) ?? process.cwd();
  return [
    'agent-browser ships a shim that downloads Chrome on postinstall.',
    'Install with:',
    `  cd ${root} && bun install`,
    `  cd ${root} && bunx agent-browser install   (downloads Chrome if the shim is present but Chrome is missing)`,
  ].join('\n');
}

//#endregion

//#region Manifest

export const BINARY_MANIFEST: ReadonlyArray<BinaryDescriptor> = [
  {
    id: 'rtk',
    displayName: 'rtk',
    summary: 'Filters and summarizes shell command output to reduce token cost.',
    kind: 'path',
    detect: async () => detectRtk(),
    installOptionsFor: rtkInstallOptions,
    manualInstructionsFor: rtkManualInstructions,
    affects: [
      {
        toolId: 'bash',
        mode: 'degrade',
      },
    ],
  },
  {
    id: 'pilotty',
    displayName: 'pilotty',
    summary: 'Drives interactive TUI programs (vim, htop, lazygit) from the agent.',
    kind: 'workspace-dep',
    detect: detectPilotty,
    installOptionsFor: pilottyInstallOptions,
    manualInstructionsFor: pilottyManualInstructions,
    affects: [
      {
        toolId: 'interactive-terminal',
        mode: 'omit',
      },
    ],
  },
  {
    id: 'agent-browser',
    displayName: 'agent-browser',
    summary: 'Headless Chrome automation for the browser tool.',
    kind: 'workspace-dep',
    detect: detectAgentBrowser,
    installOptionsFor: agentBrowserInstallOptions,
    manualInstructionsFor: agentBrowserManualInstructions,
    affects: [
      {
        toolId: 'browser',
        mode: 'omit',
      },
    ],
  },
];

//#endregion
