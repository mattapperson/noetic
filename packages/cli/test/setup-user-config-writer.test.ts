import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendIgnoredBinary, readUserSetup } from '../src/setup/user-config-writer.js';

describe('appendIgnoredBinary', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'noetic-setup-home-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, {
      recursive: true,
      force: true,
    });
  });

  it('creates a fresh user-global setup file when none exists', async () => {
    const result = await appendIgnoredBinary('rtk');
    expect(result.status).toBe('written');
    const expected = join(tmpHome, '.config', 'noetic', 'setup.json');
    expect(result.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    const parsed = JSON.parse(readFileSync(expected, 'utf8'));
    expect(parsed).toEqual({
      ignoredBinaries: [
        'rtk',
      ],
    });
  });

  it('is idempotent when the id is already listed', async () => {
    const first = await appendIgnoredBinary('rtk');
    expect(first.status).toBe('written');
    const second = await appendIgnoredBinary('rtk');
    expect(second.status).toBe('already-present');
    const parsed = JSON.parse(readFileSync(first.path, 'utf8'));
    expect(parsed.ignoredBinaries).toEqual([
      'rtk',
    ]);
  });

  it('appends a second id to an existing file', async () => {
    await appendIgnoredBinary('rtk');
    const result = await appendIgnoredBinary('pilotty');
    expect(result.status).toBe('written');
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(parsed.ignoredBinaries).toEqual([
      'rtk',
      'pilotty',
    ]);
  });

  it('treats a malformed setup file as empty — no error, no crash', async () => {
    const path = join(tmpHome, '.config', 'noetic', 'setup.json');
    mkdirSync(join(tmpHome, '.config', 'noetic'), {
      recursive: true,
    });
    writeFileSync(path, 'this is not JSON');
    const read = await readUserSetup();
    expect(read.ignoredBinaries).toEqual([]);

    // And the next append just overwrites with the valid shape.
    const result = await appendIgnoredBinary('rtk');
    expect(result.status).toBe('written');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.ignoredBinaries).toEqual([
      'rtk',
    ]);
  });

  it('strips ids not in the BinaryId enum on read', async () => {
    const path = join(tmpHome, '.config', 'noetic', 'setup.json');
    mkdirSync(join(tmpHome, '.config', 'noetic'), {
      recursive: true,
    });
    writeFileSync(
      path,
      JSON.stringify({
        ignoredBinaries: [
          'rtk',
          'not-a-real-binary',
        ],
      }),
    );
    // Schema rejects unknown ids entirely — whole file is treated as malformed.
    const read = await readUserSetup();
    expect(read.ignoredBinaries).toEqual([]);
  });
});
