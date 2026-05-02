import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNoeticConfigError } from '@noetic/core';
import { createDefaultShellAdapter } from '../src/harness/shell-adapter-bootstrap.js';
import type { AgentConfig } from '../src/types/config.js';

function makeConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    model: 'test-model',
    cwd: process.cwd(),
    apiKey: 'test',
    maxTurns: 1,
    ...overrides,
  };
}

describe('createDefaultShellAdapter', () => {
  let originalPath: string | undefined;
  let fakeBinDir: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (fakeBinDir) {
      rmSync(fakeBinDir, {
        recursive: true,
        force: true,
      });
      fakeBinDir = undefined;
    }
  });

  it('returns a working adapter when shell.useRtk is false', () => {
    process.env.PATH = '/nonexistent';
    const adapter = createDefaultShellAdapter(
      makeConfig({
        shell: {
          useRtk: false,
        },
      }),
    );
    expect(adapter.useRtk).toBe(false);
    expect(adapter.rtkAvailable).toBe(false);
  });

  it('throws NoeticConfigError when useRtk is the default and rtk is missing', () => {
    process.env.PATH = '/nonexistent';
    try {
      createDefaultShellAdapter(makeConfig({}));
      throw new Error('expected createDefaultShellAdapter to throw');
    } catch (err) {
      if (!isNoeticConfigError(err)) {
        throw err;
      }
      expect(err.code).toBe('RTK_NOT_FOUND');
      expect(err.hint).toContain('brew install rtk');
      expect(err.docsUrl).toBe('https://github.com/rtk-ai/rtk');
    }
  });

  it('returns an rtk-wrapped adapter when rtk is on PATH and useRtk is enabled', () => {
    fakeBinDir = mkdtempSync(join(tmpdir(), 'rtk-shim-'));
    const rtkPath = join(fakeBinDir, 'rtk');
    writeFileSync(rtkPath, '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;

    const adapter = createDefaultShellAdapter(
      makeConfig({
        shell: {
          useRtk: true,
        },
      }),
    );
    expect(adapter.rtkAvailable).toBe(true);
    expect(adapter.rtkPath).toBe(rtkPath);
  });
});
