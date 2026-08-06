/**
 * Agent Plugins §4.1 — package path containment.
 *
 * Every case here uses a real directory tree with real symlinks. Containment
 * is a statement about what the filesystem resolves a path to, so a fake would
 * only test the lexical half of the rule and miss the half that matters.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  containedPath,
  isPluginRelativePath,
  resolvePluginRelative,
  resolveRoot,
} from '../src/paths';
import { cleanupFixtures, linkFixture, tempDir } from './_helpers';

afterAll(cleanupFixtures);

/** A plugin root with a file inside, plus a sibling directory outside it. */
async function fixture(): Promise<{
  root: string;
  outside: string;
}> {
  const base = await tempDir();
  const root = join(base, 'plugin');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'skills', 'deploy'), {
    recursive: true,
  });
  await mkdir(outside, {
    recursive: true,
  });
  await writeFile(join(root, 'skills', 'deploy', 'SKILL.md'), 'x', 'utf8');
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
  return {
    root,
    outside,
  };
}

describe('isPluginRelativePath', () => {
  test("accepts only './'-prefixed values", () => {
    expect(isPluginRelativePath('./bin/server')).toBe(true);
    expect(isPluginRelativePath('bin/server')).toBe(false);
    expect(isPluginRelativePath('../bin/server')).toBe(false);
    expect(isPluginRelativePath('/bin/server')).toBe(false);
  });
});

describe('resolveRoot', () => {
  test('resolves an existing directory', async () => {
    const { root } = await fixture();
    expect(await resolveRoot(root)).toBe(root);
  });

  test('returns null for a directory that does not exist', async () => {
    const base = await tempDir();
    expect(await resolveRoot(join(base, 'absent'))).toBeNull();
  });
});

describe('resolvePluginRelative', () => {
  test('resolves a contained path', async () => {
    const { root } = await fixture();
    const result = await resolvePluginRelative(root, './skills/deploy/SKILL.md');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.path).toBe(join(root, 'skills', 'deploy', 'SKILL.md'));
  });

  test('rejects a value that is not plugin-relative', async () => {
    const { root } = await fixture();
    const result = await resolvePluginRelative(root, 'skills/deploy');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('not-relative');
  });

  test('rejects a traversal out of the root', async () => {
    const { root } = await fixture();
    const result = await resolvePluginRelative(root, './../outside/secret.txt');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('escapes-root');
  });
});

describe('containedPath', () => {
  test('accepts the root itself', async () => {
    const { root } = await fixture();
    const result = await containedPath(root, root);
    expect(result.ok).toBe(true);
  });

  test('does not treat a sibling with the root as a prefix as contained', async () => {
    const base = await tempDir();
    const root = join(base, 'plugin');
    const sibling = join(base, 'plugin-evil');
    await mkdir(root, {
      recursive: true,
    });
    await mkdir(sibling, {
      recursive: true,
    });
    const result = await containedPath(root, sibling);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('escapes-root');
  });

  test('follows a symlink whose target is still inside the root', async () => {
    const { root } = await fixture();
    await linkFixture(join(root, 'alias'), join(root, 'skills'), 'dir');
    const result = await containedPath(root, join(root, 'alias', 'deploy', 'SKILL.md'));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Reported as the resolved path, not the path through the symlink.
    expect(result.path).toBe(join(root, 'skills', 'deploy', 'SKILL.md'));
  });

  test('rejects a symlink escaping the root, which a lexical check would allow', async () => {
    const { root, outside } = await fixture();
    await linkFixture(join(root, 'skills', 'sneaky'), outside, 'dir');
    // Lexically `<root>/skills/sneaky/secret.txt` sits inside the root; only
    // realpath reveals it does not.
    const result = await containedPath(root, join(root, 'skills', 'sneaky', 'secret.txt'));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('escapes-root');
  });

  test('accepts a not-yet-created leaf under an existing root', async () => {
    // A client must be able to containment-check a directory it is about to
    // create, such as a PLUGIN_DATA subdirectory.
    const { root } = await fixture();
    const result = await containedPath(root, join(root, 'not-created-yet', 'nested'));
    expect(result.ok).toBe(true);
  });

  test('rejects a not-yet-created leaf reached through an escaping symlink', async () => {
    const { root, outside } = await fixture();
    await linkFixture(join(root, 'link'), outside, 'dir');
    const result = await containedPath(root, join(root, 'link', 'new-file'));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('escapes-root');
  });

  test('resolves the root as well, so a symlinked root is not a false escape', async () => {
    // The system temp directory is itself a symlink on macOS, so comparing a
    // resolved child against an unresolved root would report every path as an
    // escape.
    const base = await tempDir();
    const real = join(base, 'real-root');
    await mkdir(join(real, 'inner'), {
      recursive: true,
    });
    const linkedRoot = join(base, 'linked-root');
    await linkFixture(linkedRoot, real, 'dir');

    const result = await containedPath(linkedRoot, join(linkedRoot, 'inner'));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.path).toBe(join(real, 'inner'));
  });
});
