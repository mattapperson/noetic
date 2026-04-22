import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlugFor, sessionFilePath, sessionsDirFor } from '../src/sessions/paths.js';
import {
  findMostRecentSession,
  listSessionsForCwd,
  loadSession,
  loadSessionByIdAnywhere,
  saveSession,
} from '../src/sessions/store.js';
import type { SessionFile } from '../src/sessions/types.js';

const originalOverride = process.env.NOETIC_SESSIONS_DIR;
const createdDirs: string[] = [];

afterEach(async () => {
  if (originalOverride === undefined) {
    process.env.NOETIC_SESSIONS_DIR = undefined;
    delete process.env.NOETIC_SESSIONS_DIR;
  } else {
    process.env.NOETIC_SESSIONS_DIR = originalOverride;
  }
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, {
      recursive: true,
      force: true,
    });
  }
});

async function makeSessionsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'noetic-sessions-'));
  createdDirs.push(root);
  process.env.NOETIC_SESSIONS_DIR = root;
  return root;
}

function makeSession(overrides: Partial<SessionFile> = {}): SessionFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId: '11111111-2222-4333-8444-555555555555',
    cwd: '/tmp/fake-project',
    effectiveCwd: '/tmp/fake-project',
    model: 'anthropic/claude-sonnet-4',
    agentMode: 'normal',
    createdAt: now,
    modifiedAt: now,
    firstPrompt: 'hello world',
    messageCount: 1,
    cumulativeUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
    },
    cumulativeCost: 0,
    items: [
      {
        id: 'msg-1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: 'hello world',
          },
        ],
      },
    ],
    entries: [
      {
        role: 'user',
        content: 'hello world',
      },
    ],
    ...overrides,
  };
}

describe('saveSession + loadSession', () => {
  it('round-trips a session file through atomic write', async () => {
    await makeSessionsRoot();
    const session = makeSession();
    const result = await saveSession(session);
    expect(result.conflict).toBe(false);
    expect(result.mtimeMs).toBeGreaterThan(0);

    const loaded = await loadSession(session.cwd, session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.firstPrompt).toBe('hello world');
    expect(loaded?.items).toHaveLength(1);
  });

  it('creates the sessions directory if missing', async () => {
    await makeSessionsRoot();
    const session = makeSession();
    await saveSession(session);
    const dir = sessionsDirFor(session.cwd);
    expect(existsSync(dir)).toBe(true);
  });

  it('leaves no .tmp file behind after success', async () => {
    await makeSessionsRoot();
    const session = makeSession();
    await saveSession(session);
    const dir = sessionsDirFor(session.cwd);
    const entries = await readdir(dir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('reports conflict=true when on-disk mtime is newer than lastKnownMtimeMs', async () => {
    await makeSessionsRoot();
    const session = makeSession();
    const first = await saveSession(session);
    // Simulate: we wrote, another process wrote again, then we save with our
    // stale mtime knowledge.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await saveSession({
      ...session,
      firstPrompt: 'concurrent writer',
    });
    const third = await saveSession(session, {
      lastKnownMtimeMs: first.mtimeMs,
    });
    expect(third.conflict).toBe(true);
  });

  it('returns null for a missing session', async () => {
    await makeSessionsRoot();
    const loaded = await loadSession('/tmp/never-existed', '00000000-0000-0000-0000-000000000000');
    expect(loaded).toBeNull();
  });
});

describe('listSessionsForCwd', () => {
  it('lists sessions in the current cwd sorted newest-first', async () => {
    await makeSessionsRoot();
    const older = makeSession({
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      createdAt: '2025-01-01T00:00:00.000Z',
      modifiedAt: '2025-01-01T00:00:00.000Z',
    });
    const newer = makeSession({
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000002',
      createdAt: '2025-06-01T00:00:00.000Z',
      modifiedAt: '2025-06-01T00:00:00.000Z',
    });
    await saveSession(older);
    await saveSession(newer);

    const metas = await listSessionsForCwd(older.cwd);
    expect(metas).toHaveLength(2);
    expect(metas[0].sessionId).toBe(newer.sessionId);
    expect(metas[1].sessionId).toBe(older.sessionId);
  });

  it('hides sessions with messageCount 0', async () => {
    await makeSessionsRoot();
    const empty = makeSession({
      sessionId: 'bbbbbbbb-0000-4000-8000-000000000001',
      messageCount: 0,
    });
    await saveSession(empty);
    const metas = await listSessionsForCwd(empty.cwd);
    expect(metas).toHaveLength(0);
  });

  it('skips malformed json files without throwing', async () => {
    await makeSessionsRoot();
    const session = makeSession();
    await saveSession(session);
    const dir = sessionsDirFor(session.cwd);
    await writeFile(join(dir, 'garbage.json'), '{not json');
    const metas = await listSessionsForCwd(session.cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0].sessionId).toBe(session.sessionId);
  });

  it('returns [] if the dir does not exist', async () => {
    await makeSessionsRoot();
    const metas = await listSessionsForCwd('/tmp/never-created');
    expect(metas).toEqual([]);
  });
});

describe('findMostRecentSession', () => {
  it('returns the most recently modified session for the cwd', async () => {
    await makeSessionsRoot();
    const older = makeSession({
      sessionId: 'cccccccc-0000-4000-8000-000000000001',
      firstPrompt: 'older',
      createdAt: '2025-01-01T00:00:00.000Z',
      modifiedAt: '2025-01-01T00:00:00.000Z',
    });
    const newer = makeSession({
      sessionId: 'cccccccc-0000-4000-8000-000000000002',
      firstPrompt: 'newer',
      createdAt: '2025-06-01T00:00:00.000Z',
      modifiedAt: '2025-06-01T00:00:00.000Z',
    });
    await saveSession(older);
    await saveSession(newer);
    const found = await findMostRecentSession(older.cwd);
    expect(found?.sessionId).toBe(newer.sessionId);
    expect(found?.firstPrompt).toBe('newer');
  });

  it('returns null when no sessions exist', async () => {
    await makeSessionsRoot();
    const found = await findMostRecentSession('/tmp/nothing-here');
    expect(found).toBeNull();
  });
});

describe('loadSessionByIdAnywhere', () => {
  it('finds a session stored under a different cwd slug', async () => {
    await makeSessionsRoot();
    const session = makeSession({
      cwd: '/tmp/project-a',
      sessionId: 'dddddddd-0000-4000-8000-000000000001',
    });
    await saveSession(session);
    const found = await loadSessionByIdAnywhere(session.sessionId);
    expect(found?.sessionId).toBe(session.sessionId);
  });

  it('returns null if no project contains the id', async () => {
    await makeSessionsRoot();
    const found = await loadSessionByIdAnywhere('eeeeeeee-0000-4000-8000-000000000001');
    expect(found).toBeNull();
  });
});

describe('sessionFilePath integration', () => {
  it('places the file under the resolved slug directory', async () => {
    const root = await makeSessionsRoot();
    const session = makeSession();
    await saveSession(session);
    const expected = join(
      root,
      projectSlugFor(session.cwd),
      'sessions',
      `${session.sessionId}.json`,
    );
    expect(existsSync(expected)).toBe(true);
    expect(sessionFilePath(session.cwd, session.sessionId)).toBe(expected);
  });
});
