/**
 * OS + package manager detection.
 *
 * All detection happens at runtime: what we recommend to macOS with Homebrew
 * is different from bare Linux with only cargo, and Windows is manual-only
 * for now. Keep the OS check cheap (no shell-outs) and the PM check parallel.
 */

import type { OsKind, PackageManager } from './types.js';

//#region OS

export function detectOs(): OsKind {
  const platform = process.platform;
  if (platform === 'darwin') {
    return 'macos';
  }
  if (platform === 'linux') {
    return 'linux';
  }
  if (platform === 'win32') {
    return 'windows';
  }
  return 'other';
}

//#endregion

//#region Package managers

/**
 * Per-OS candidate list, ordered by our install preference. The first entry
 * that resolves on PATH is what we'd recommend by default; the setup UI still
 * shows every detected option.
 */
function candidatesFor(os: OsKind): ReadonlyArray<PackageManager> {
  if (os === 'macos') {
    return [
      'brew',
      'cargo',
      'curl',
      'bun',
      'bunx',
    ];
  }
  if (os === 'linux') {
    return [
      'brew',
      'apt',
      'dnf',
      'pacman',
      'zypper',
      'cargo',
      'curl',
      'bun',
      'bunx',
    ];
  }
  if (os === 'windows') {
    return [
      'winget',
      'scoop',
      'cargo',
      'curl',
      'bun',
      'bunx',
    ];
  }
  return [
    'curl',
    'bun',
    'bunx',
  ];
}

function pmBinary(pm: PackageManager): string {
  if (pm === 'brew') {
    return 'brew';
  }
  if (pm === 'apt') {
    return 'apt-get';
  }
  if (pm === 'dnf') {
    return 'dnf';
  }
  if (pm === 'pacman') {
    return 'pacman';
  }
  if (pm === 'zypper') {
    return 'zypper';
  }
  if (pm === 'cargo') {
    return 'cargo';
  }
  if (pm === 'curl') {
    return 'curl';
  }
  if (pm === 'bun') {
    return 'bun';
  }
  if (pm === 'bunx') {
    return 'bunx';
  }
  if (pm === 'winget') {
    return 'winget';
  }
  if (pm === 'scoop') {
    return 'scoop';
  }
  return pm;
}

/**
 * Detects which package managers exist on PATH, in preference order for the
 * given OS. `which` is used instead of running anything — we don't want to
 * trigger package-manager cold starts during CLI boot.
 */
export async function detectPackageManagers(
  os: OsKind = detectOs(),
  path: string = process.env.PATH ?? '',
): Promise<ReadonlyArray<PackageManager>> {
  const candidates = candidatesFor(os);
  const checks = candidates.map((pm) => ({
    pm,
    resolved: Bun.which(pmBinary(pm), {
      PATH: path,
    }),
  }));
  return checks.filter((c) => c.resolved !== null).map((c) => c.pm);
}

//#endregion
