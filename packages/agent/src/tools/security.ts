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
