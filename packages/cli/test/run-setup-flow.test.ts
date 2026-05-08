/**
 * Tests for the non-interactive path of `runSetupFlow`. The interactive path
 * renders an Ink screen and is covered via the screen's pure helpers and
 * resolver/manifest unit tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSetupFlow } from '../src/cli/run-setup-flow.js';
import type { AgentConfig } from '../src/types/config.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: 'x',
    cwd: '/tmp',
    apiKey: 'k',
    maxTurns: 1,
    ...overrides,
  };
}

describe('runSetupFlow (non-interactive)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    tmpHome = mkdtempSync(join(tmpdir(), 'noetic-setup-flow-'));
    process.env.HOME = tmpHome;
    // Scrub rtk + pilotty + agent-browser out of PATH so the detectors report missing.
    process.env.PATH = '/nonexistent-path';
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
    rmSync(tmpHome, {
      recursive: true,
      force: true,
    });
  });

  it('skips every missing binary with a stderr notice in non-TTY mode', async () => {
    const notices: string[] = [];
    const result = await runSetupFlow({
      config: makeConfig(),
      isInteractive: false,
      writeNotice: (line) => notices.push(line),
    });

    expect(notices.length).toBeGreaterThan(0);
    expect(notices.join('')).toContain('is missing');

    // Every binary should have a terminal value (present or ignored) in the map.
    const keys: string[] = [
      ...result.keys(),
    ];
    keys.sort();
    expect(keys).toEqual([
      'agent-browser',
      'pilotty',
      'rtk',
    ]);

    // None should be `'missing'` — the coordinator always resolves ambiguity.
    for (const v of result.values()) {
      expect(v === 'present' || v === 'ignored').toBe(true);
    }
  });

  it('returns immediately with no notices when nothing is missing', async () => {
    const notices: string[] = [];
    // Every binary listed as ignored → nothing is "missing".
    const result = await runSetupFlow({
      config: makeConfig({
        setup: {
          ignoredBinaries: [
            'rtk',
            'pilotty',
            'agent-browser',
          ],
        },
      }),
      isInteractive: false,
      writeNotice: (line) => notices.push(line),
    });

    expect(notices).toEqual([]);
    expect(result.get('rtk')).toBe('ignored');
    expect(result.get('pilotty')).toBe('ignored');
    expect(result.get('agent-browser')).toBe('ignored');
  });
});
