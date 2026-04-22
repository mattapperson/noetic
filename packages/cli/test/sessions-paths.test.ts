import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  projectSlugFor,
  sessionFilePath,
  sessionsDirFor,
  sessionsRootDir,
} from '../src/sessions/paths.js';

const originalOverride = process.env.NOETIC_SESSIONS_DIR;

beforeEach(() => {
  delete process.env.NOETIC_SESSIONS_DIR;
});

afterEach(() => {
  if (originalOverride === undefined) {
    delete process.env.NOETIC_SESSIONS_DIR;
    return;
  }
  process.env.NOETIC_SESSIONS_DIR = originalOverride;
});

describe('projectSlugFor', () => {
  it('strips leading slash and replaces separators with dashes', () => {
    expect(projectSlugFor('/Users/matt/code/app')).toBe('Users-matt-code-app');
  });

  it('handles a trailing slash', () => {
    expect(projectSlugFor('/Users/matt/')).toBe('Users-matt');
  });

  it('returns "root" for "/" and ""', () => {
    expect(projectSlugFor('/')).toBe('root');
    expect(projectSlugFor('')).toBe('root');
  });

  it('known collision case: /a/b and /a-b map to the same slug', () => {
    expect(projectSlugFor('/a/b')).toBe(projectSlugFor('/a-b'));
  });
});

describe('sessionsRootDir', () => {
  it('lives under ~/.noetic/projects', () => {
    expect(sessionsRootDir()).toBe(join(homedir(), '.noetic', 'projects'));
  });
});

describe('sessionsDirFor', () => {
  it('nests sessions under the project slug', () => {
    const cwd = '/Users/matt/code/app';
    expect(sessionsDirFor(cwd)).toBe(
      join(homedir(), '.noetic', 'projects', 'Users-matt-code-app', 'sessions'),
    );
  });
});

describe('sessionFilePath', () => {
  it('appends {sessionId}.json', () => {
    const cwd = '/Users/matt/code/app';
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(sessionFilePath(cwd, id)).toBe(
      join(homedir(), '.noetic', 'projects', 'Users-matt-code-app', 'sessions', `${id}.json`),
    );
  });
});
