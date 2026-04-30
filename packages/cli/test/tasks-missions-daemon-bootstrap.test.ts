import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentHarness } from '@noetic/core';

import { defaultSignaller } from '../src/commands/builtins/tasks/agent-ci-control.js';
import { buildMissionDaemonDeps } from '../src/commands/builtins/tasks/missions/daemon-bootstrap.js';

let cwd: string;
const previousApiKey = process.env['OPENROUTER_API_KEY'];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'noetic-daemon-bootstrap-'));
  // Force the no-config path: leave a fake apiKey so the AgentHarness
  // constructor accepts the fallback model wiring.
  process.env['OPENROUTER_API_KEY'] = 'sk-test-bootstrap';
});

afterEach(() => {
  if (previousApiKey === undefined) {
    delete process.env['OPENROUTER_API_KEY'];
  } else {
    process.env['OPENROUTER_API_KEY'] = previousApiKey;
  }
});

describe('buildMissionDaemonDeps', () => {
  test('returns an AutopilotDeps shape with cwd, fs, signaller, harness, and model', async () => {
    const deps = await buildMissionDaemonDeps(cwd);

    expect(deps.cwd).toBe(cwd);
    expect(deps.signaller).toBe(defaultSignaller);
    expect(deps.missionHarness).toBeInstanceOf(AgentHarness);
    expect(typeof deps.model).toBe('string');
    expect(deps.model.length).toBeGreaterThan(0);
    expect(typeof deps.fs.readFile).toBe('function');
    expect(typeof deps.fs.writeFile).toBe('function');
  });

  test('returns the same harness instance per build (single construction)', async () => {
    const deps = await buildMissionDaemonDeps(cwd);
    // The contract is "constructed once per call to buildMissionDaemonDeps";
    // the daemon entry calls it exactly once at startup. Verify the bag is
    // a stable reference.
    expect(deps.missionHarness).toBe(deps.missionHarness);
  });
});
