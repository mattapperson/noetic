import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalFsAdapter } from '@noetic-tools/platform-node';

import { findNearestRoot, findNearestRootSync } from '../src/lsp/root-resolver.js';

const fs = createLocalFsAdapter();

describe('findNearestRoot', () => {
  let root: string;
  let outerPkg: string;
  let innerPkg: string;
  let leafFile: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'noetic-lsp-root-'));
    outerPkg = join(root, 'outer');
    innerPkg = join(outerPkg, 'packages', 'inner');
    await mkdir(innerPkg, {
      recursive: true,
    });
    await writeFile(join(outerPkg, 'package.json'), '{}', 'utf8');
    await writeFile(join(innerPkg, 'package.json'), '{}', 'utf8');
    await writeFile(join(innerPkg, 'src.ts'), '// leaf', 'utf8');
    leafFile = join(innerPkg, 'src.ts');
  });

  afterAll(async () => {
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it('finds the nearest ancestor containing a marker (not the furthest)', async () => {
    const found = await findNearestRoot(fs, leafFile, [
      'package.json',
    ]);
    expect(found).toBe(innerPkg);
  });

  it('walks up to the outer marker when the nearest directory has none', async () => {
    const orphan = join(outerPkg, 'lonely-subdir', 'x.ts');
    await mkdir(join(outerPkg, 'lonely-subdir'), {
      recursive: true,
    });
    await writeFile(orphan, '', 'utf8');
    const found = await findNearestRoot(fs, orphan, [
      'package.json',
    ]);
    expect(found).toBe(outerPkg);
  });

  it('returns null when no marker is found', async () => {
    const found = await findNearestRoot(fs, leafFile, [
      'definitely-not-here.txt',
    ]);
    expect(found).toBeNull();
  });

  it('returns null for empty marker list', async () => {
    const found = await findNearestRoot(fs, leafFile, []);
    expect(found).toBeNull();
  });

  it('sync variant matches async result', async () => {
    const fromSync = findNearestRootSync(leafFile, [
      'package.json',
    ]);
    const fromAsync = await findNearestRoot(fs, leafFile, [
      'package.json',
    ]);
    expect(fromSync).toBe(fromAsync);
  });
});
