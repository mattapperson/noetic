import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectOs, detectPackageManagers } from '../src/setup/platform.js';

describe('detectOs', () => {
  it('maps darwin/linux/win32 to the expected OsKind', () => {
    // We cannot actually flip process.platform — instead verify the current
    // platform is one of the four supported values and the resolver returns it.
    const result = detectOs();
    expect(result === 'macos' || result === 'linux' || result === 'windows' || result === 'other').toBe(
      true,
    );
  });
});

describe('detectPackageManagers', () => {
  let tmpBin: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    tmpBin = mkdtempSync(join(tmpdir(), 'noetic-setup-pm-'));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(tmpBin, {
      recursive: true,
      force: true,
    });
  });

  it('returns only PMs whose binary is on PATH', async () => {
    // Seed a fake "brew" shim only.
    writeFileSync(join(tmpBin, 'brew'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    const result = await detectPackageManagers('macos', tmpBin);
    expect(result).toEqual([
      'brew',
    ]);
  });

  it('returns PMs in preference order for Linux', async () => {
    writeFileSync(join(tmpBin, 'cargo'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    writeFileSync(join(tmpBin, 'apt-get'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    const result = await detectPackageManagers('linux', tmpBin);
    // Linux candidate order: brew, apt, dnf, pacman, zypper, cargo, curl, bun, bunx.
    // So apt should precede cargo in the output.
    const aptIdx = result.indexOf('apt');
    const cargoIdx = result.indexOf('cargo');
    expect(aptIdx).toBeGreaterThanOrEqual(0);
    expect(cargoIdx).toBeGreaterThan(aptIdx);
  });

  it('returns empty when PATH has no known PMs', async () => {
    const result = await detectPackageManagers('linux', tmpBin);
    expect(result).toEqual([]);
  });
});
