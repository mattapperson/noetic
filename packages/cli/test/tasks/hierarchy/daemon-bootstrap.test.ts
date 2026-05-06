import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildHierarchyDaemonHarness } from '../../../src/tasks/runtime/hierarchy/daemon-bootstrap.js';

describe('buildHierarchyDaemonHarness', () => {
  it('builds an AgentHarness, the composed flow, and the channel triple', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'noetic-bootstrap-'));
    try {
      const bundle = await buildHierarchyDaemonHarness(projectRoot);
      expect(bundle.harness).toBeDefined();
      expect(bundle.flow.kind).toBe('spawn');
      expect(bundle.channels.validatorRequestChan.name).toBe('tasks.validator-request');
      expect(bundle.channels.featureLoopStateChan.name).toBe('tasks.feature-loop-state');
      expect(bundle.channels.externalTaskEventsChan.name).toBe('tasks.events');
    } finally {
      await rm(projectRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it('returns a fresh harness for each project root', async () => {
    const a = await buildHierarchyDaemonHarness('/tmp/a');
    const b = await buildHierarchyDaemonHarness('/tmp/b');
    expect(a).not.toBe(b);
    expect(a.harness).not.toBe(b.harness);
  });
});
