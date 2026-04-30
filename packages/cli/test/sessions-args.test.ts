import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { parseArgs } from '../src/cli/args.js';

const originalExit = process.exit;
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalApiKey = process.env.OPENROUTER_API_KEY;

/**
 * Stub that throws instead of exiting. parseArgs uses `process.exit(1)` for
 * user errors; in tests we want to observe those without dying.
 */
function stubExit(code?: number | string | null): never {
  throw Object.assign(new Error('process.exit called'), {
    code: typeof code === 'number' ? code : 1,
  });
}

function silentWrite(): true {
  return true;
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.exit = stubExit;
  process.stderr.write = silentWrite;
  process.stdout.write = silentWrite;
});

afterEach(() => {
  process.exit = originalExit;
  process.stderr.write = originalStderrWrite;
  process.stdout.write = originalStdoutWrite;
  if (originalApiKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
    return;
  }
  process.env.OPENROUTER_API_KEY = originalApiKey;
});

function cli(...extra: string[]): ReturnType<typeof parseArgs> {
  return parseArgs([
    'bun',
    'cli.ts',
    ...extra,
  ]);
}

describe('parseArgs — session flags', () => {
  it('defaults all session flags to false/undefined when none supplied', () => {
    const { flags } = cli();
    expect(flags.continueLatest).toBe(false);
    expect(flags.resume).toBe(false);
    expect(flags.forkSession).toBe(false);
    expect(flags.sessionId).toBeUndefined();
    expect(flags.name).toBeUndefined();
    expect(flags.noSessionPersistence).toBe(false);
  });

  it('parses -c / --continue', () => {
    expect(cli('-c').flags.continueLatest).toBe(true);
    expect(cli('--continue').flags.continueLatest).toBe(true);
  });

  it('parses bare -r / --resume as true (picker mode)', () => {
    expect(cli('-r').flags.resume).toBe(true);
    expect(cli('--resume').flags.resume).toBe(true);
  });

  it('parses --resume <uuid> as the uuid string', () => {
    const uuid = 'aaaaaaaa-0000-4000-8000-000000000001';
    expect(cli('--resume', uuid).flags.resume).toBe(uuid);
  });

  it('leaves a non-UUID token alone after --resume (picker mode)', () => {
    const result = cli('--resume', '--model', 'foo/bar');
    expect(result.flags.resume).toBe(true);
    expect(result.config.model).toBe('foo/bar');
  });

  it('parses --session-id with a valid UUID', () => {
    const uuid = 'bbbbbbbb-0000-4000-8000-000000000002';
    expect(cli('--session-id', uuid).flags.sessionId).toBe(uuid);
  });

  it('rejects --session-id with a bad UUID', () => {
    expect(() => cli('--session-id', 'not-a-uuid')).toThrow(/process\.exit/i);
  });

  it('parses -n / --name', () => {
    expect(cli('-n', 'bug triage').flags.name).toBe('bug triage');
    expect(cli('--name', 'spike').flags.name).toBe('spike');
  });

  it('parses --fork-session but requires --continue or --resume', () => {
    expect(cli('--fork-session', '-c').flags.forkSession).toBe(true);
    expect(cli('--fork-session', '-r').flags.forkSession).toBe(true);
    expect(() => cli('--fork-session')).toThrow(/process\.exit/i);
  });

  it('parses --no-session-persistence', () => {
    expect(cli('--no-session-persistence').flags.noSessionPersistence).toBe(true);
  });

  it('coexists with existing flags', () => {
    const { config, flags } = cli(
      '--model',
      'openai/gpt-4o',
      '--cwd',
      '/tmp/x',
      '-c',
      '-n',
      'work',
    );
    expect(config.model).toBe('openai/gpt-4o');
    expect(config.cwd).toBe('/tmp/x');
    expect(flags.continueLatest).toBe(true);
    expect(flags.name).toBe('work');
  });
});
