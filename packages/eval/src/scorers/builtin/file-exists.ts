import * as fs from 'node:fs';

import type { ScorerFn } from '../types';

//#region Types

interface FileExistsConfig {
  paths: string[];
  shouldNotExist?: string[];
  contentMatches?: Record<string, RegExp>;
}

//#endregion

//#region Helper Functions

function checkExistingPaths(
  config: FileExistsConfig,
  details: string[],
): {
  passed: number;
  extraTotal: number;
} {
  let passed = 0;
  let extraTotal = 0;

  for (const path of config.paths) {
    if (!fs.existsSync(path)) {
      details.push(`${path}: missing`);
      continue;
    }

    passed++;

    if (!config.contentMatches?.[path]) {
      continue;
    }

    extraTotal++;
    const content = fs.readFileSync(path, 'utf-8');
    if (config.contentMatches[path].test(content)) {
      passed++;
    } else {
      details.push(`${path}: content mismatch`);
    }
  }

  return {
    passed,
    extraTotal,
  };
}

function checkNonExistingPaths(paths: string[], details: string[]): number {
  let passed = 0;

  for (const path of paths) {
    if (!fs.existsSync(path)) {
      passed++;
    } else {
      details.push(`${path}: should not exist`);
    }
  }

  return passed;
}

//#endregion

//#region Public API

export function fileExists(config: FileExistsConfig): ScorerFn {
  return async () => {
    const details: string[] = [];
    const total = config.paths.length + (config.shouldNotExist?.length ?? 0);

    const existing = checkExistingPaths(config, details);
    const nonExistPassed = checkNonExistingPaths(config.shouldNotExist ?? [], details);

    const passed = existing.passed + nonExistPassed;
    const adjustedTotal = total + existing.extraTotal;
    const score = adjustedTotal > 0 ? passed / adjustedTotal : 1.0;

    return {
      scorerId: 'file-exists',
      score,
      reason: details.length > 0 ? details.join('; ') : 'All file checks passed',
      metadata: {
        passed,
        total: adjustedTotal,
        details,
      },
    };
  };
}

//#endregion
