import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildHierarchyDaemonDeps } from '../../../src/commands/builtins/tasks/hierarchy/daemon-bootstrap.js';

describe('buildHierarchyDaemonDeps', () => {
  it('binds the project root to a fresh local fs adapter and the default signaller', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'noetic-bootstrap-'));
    try {
      const deps = buildHierarchyDaemonDeps(projectRoot);
      expect(deps.ctx.projectRoot).toBe(projectRoot);
      expect(deps.signaller).toBeDefined();
      // Smoke-test the FsAdapter is a real one — it can write/read.
      const file = join(projectRoot, 'probe.txt');
      await deps.ctx.fs.writeFile(file, 'ok');
      expect(await deps.ctx.fs.readFileText(file)).toBe('ok');
    } finally {
      await rm(projectRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it('returns a different signaller-less binding for distinct project roots', () => {
    const a = buildHierarchyDaemonDeps('/tmp/a');
    const b = buildHierarchyDaemonDeps('/tmp/b');
    expect(a.ctx.projectRoot).toBe('/tmp/a');
    expect(b.ctx.projectRoot).toBe('/tmp/b');
    expect(a).not.toBe(b);
  });
});
