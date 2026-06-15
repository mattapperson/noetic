import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNetrcEntry, readNetrcPassword } from '../src/cli/netrc.js';

const tmpDirs: string[] = [];

function makeNetrc(body: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'netrc-test-'));
  tmpDirs.push(dir);
  const path = join(dir, 'netrc');
  writeFileSync(path, body, {
    mode,
  });
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, {
        recursive: true,
        force: true,
      });
    }
  }
});

describe('readNetrcEntry', () => {
  it('returns undefined when the file does not exist', () => {
    const result = readNetrcEntry('openrouter.ai', {
      path: '/nonexistent/netrc',
    });
    expect(result).toBeUndefined();
  });

  it('parses a single-line entry', () => {
    const path = makeNetrc('machine openrouter.ai login api password sk-or-test\n');
    const result = readNetrcEntry('openrouter.ai', {
      path,
    });
    expect(result?.entry).toEqual({
      machine: 'openrouter.ai',
      login: 'api',
      password: 'sk-or-test',
    });
  });

  it('parses a multi-line indented entry', () => {
    const body = [
      'machine openrouter.ai',
      '  login api',
      '  password sk-or-multi',
      '',
    ].join('\n');
    const path = makeNetrc(body);
    const result = readNetrcEntry('openrouter.ai', {
      path,
    });
    expect(result?.entry.password).toBe('sk-or-multi');
    expect(result?.entry.login).toBe('api');
  });

  it('returns the matching entry when multiple machines are present', () => {
    const body = [
      'machine example.com login alice password pw1',
      'machine openrouter.ai login api password sk-or-correct',
      'machine other.com login bob password pw2',
      '',
    ].join('\n');
    const path = makeNetrc(body);
    const result = readNetrcEntry('openrouter.ai', {
      path,
    });
    expect(result?.entry.password).toBe('sk-or-correct');
  });

  it('falls back to the default block when no exact match exists', () => {
    const body = [
      'default login any password fallback-key',
      '',
    ].join('\n');
    const path = makeNetrc(body);
    const result = readNetrcEntry('openrouter.ai', {
      path,
    });
    expect(result?.entry.password).toBe('fallback-key');
  });

  it('ignores comment lines', () => {
    const body = [
      '# this is a comment',
      'machine openrouter.ai login api password sk-or-commented',
      '# trailing comment',
      '',
    ].join('\n');
    const path = makeNetrc(body);
    const result = readNetrcEntry('openrouter.ai', {
      path,
    });
    expect(result?.entry.password).toBe('sk-or-commented');
  });

  it('flags permissive file modes', () => {
    const path = makeNetrc('machine openrouter.ai login api password sk-or-leaky\n', 0o644);
    const result = readNetrcEntry('openrouter.ai', {
      path,
    });
    expect(result?.permissive).toBe(true);
  });

  it('does not flag 0600 as permissive', () => {
    const path = makeNetrc('machine openrouter.ai login api password sk-or-tight\n', 0o600);
    const result = readNetrcEntry('openrouter.ai', {
      path,
    });
    expect(result?.permissive).toBe(false);
  });
});

describe('readNetrcPassword', () => {
  it('returns the password for the matching machine', () => {
    const path = makeNetrc('machine openrouter.ai login api password sk-or-pw\n');
    const pw = readNetrcPassword('openrouter.ai', {
      path,
    });
    expect(pw).toBe('sk-or-pw');
  });

  it('returns undefined when no entry matches and no default exists', () => {
    const path = makeNetrc('machine example.com login alice password pw1\n');
    const pw = readNetrcPassword('openrouter.ai', {
      path,
    });
    expect(pw).toBeUndefined();
  });
});
