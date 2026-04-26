/**
 * Bash command security validation.
 *
 * Ported from: https://github.com/OpenRouterTeam/sky
 */

//#region Constants

export const BANNED_COMMANDS = new Set([
  'sudo',
  'su',
  'chmod',
  'chown',
  'chgrp',
]);

/**
 * Commands that take over the terminal with a full-screen UI or block
 * waiting for keyboard input. Running them through this tool will hang
 * until the timeout fires, so reject upfront with a helpful error.
 */
export const INTERACTIVE_TUI_COMMANDS = new Set([
  'vim',
  'vi',
  'nvim',
  'view',
  'nano',
  'pico',
  'micro',
  'emacs',
  'joe',
  'less',
  'more',
  'most',
  'top',
  'htop',
  'btop',
  'btop++',
  'atop',
  'glances',
  'iotop',
  'iftop',
  'nethogs',
  'tmux',
  'screen',
  'zellij',
  'tig',
  'lazygit',
  'gitui',
  'mc',
  'ranger',
  'nnn',
  'lf',
  'ncdu',
  'lynx',
  'w3m',
  'links',
  'elinks',
  'mutt',
  'neomutt',
  'alpine',
  'irssi',
  'weechat',
]);

interface RiskPattern {
  pattern: RegExp;
  description: string;
}

export const HIGH_RISK_PATTERNS: RiskPattern[] = [
  {
    pattern: /curl\s+.*\|\s*(?:ba)?sh/i,
    description: 'Piping downloaded content to shell is dangerous',
  },
  {
    pattern: /wget\s+.*\|\s*(?:ba)?sh/i,
    description: 'Piping downloaded content to shell is dangerous',
  },
  {
    pattern: /rm\s+(?:-rf|-fr|.*-r.*-f|.*-f.*-r)/,
    description: 'Recursive force deletion can cause data loss',
  },
  {
    pattern: /dd\s+/,
    description: 'dd can overwrite disk data',
  },
  {
    pattern: /mkfs/,
    description: 'Filesystem operations can destroy data',
  },
  {
    pattern: /fdisk/,
    description: 'Filesystem operations can destroy data',
  },
  {
    pattern: />\s*\/dev\//,
    description: 'Writing to device files or truncating system files is dangerous',
  },
  {
    pattern: /:\s*>\s*\//,
    description: 'Writing to device files or truncating system files is dangerous',
  },
];

//#endregion

//#region Helpers

export function isHighRiskCommand(command: string): boolean {
  return HIGH_RISK_PATTERNS.some((entry) => entry.pattern.test(command));
}

export function getFirstCommand(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^(\S+)/);
  return match ? match[1] : '';
}

export function getRiskDescription(command: string): string | undefined {
  const match = HIGH_RISK_PATTERNS.find((entry) => entry.pattern.test(command));
  return match?.description;
}

//#endregion

//#region Public API

export function isBannedCommand(command: string): {
  banned: boolean;
  reason?: string;
} {
  const firstCmd = getFirstCommand(command);
  if (BANNED_COMMANDS.has(firstCmd)) {
    return {
      banned: true,
      reason: `Command '${firstCmd}' is not allowed for safety reasons`,
    };
  }
  return {
    banned: false,
  };
}

/** Returns the matched interactive command name, or undefined if the command is not interactive. */
export function isInteractiveCommand(command: string): string | undefined {
  const firstCmd = getFirstCommand(command);
  return INTERACTIVE_TUI_COMMANDS.has(firstCmd) ? firstCmd : undefined;
}

export function validateCommand(command: string): {
  valid: boolean;
  error?: string;
} {
  if (!command.trim()) {
    return {
      valid: false,
      error: 'Empty command',
    };
  }

  const banned = isBannedCommand(command);
  if (banned.banned) {
    return {
      valid: false,
      error: banned.reason,
    };
  }

  const interactiveName = isInteractiveCommand(command);
  if (interactiveName) {
    return {
      valid: false,
      error: `'${interactiveName}' is an interactive terminal program and cannot be used through this tool. Use the Read tool to view files, the Edit tool to modify them, or pipe to a non-interactive alternative.`,
    };
  }

  const riskDescription = getRiskDescription(command);
  if (riskDescription) {
    return {
      valid: false,
      error: `High-risk command blocked: ${riskDescription}`,
    };
  }

  return {
    valid: true,
  };
}

//#endregion
