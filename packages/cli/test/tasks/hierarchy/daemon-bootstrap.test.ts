import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildHierarchyDaemonHarness } from '../../../src/commands/builtins/tasks/hierarchy/daemon-bootstrap.js';

describe('buildHierarchyDaemonHarness', () => {
  it('builds an AgentHarness, the composed flow, and the channel triple', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'noetic-bootstrap-'));
    try {
      const bundle = buildHierarchyDaemonHarness(projectRoot);
      expect(bundle.harness).toBeDefined();
      expect(bundle.flow.kind).toBe('spawn');
      expect(bundle.channels.validatorRequestChan.name).toBe('tasks.validator-request');
      expect(bundle.channels.validatorOutcomeChan.name).toBe('tasks.validator-outcome');
      expect(bundle.channels.featureLoopStateChan.name).toBe('tasks.feature-loop-state');
      expect(bundle.channels.externalTaskEventsChan.name).toBe('tasks.events');
    } finally {
      await rm(projectRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it('returns a fresh harness for each project root', () => {
    const a = buildHierarchyDaemonHarness('/tmp/a');
    const b = buildHierarchyDaemonHarness('/tmp/b');
    expect(a).not.toBe(b);
    expect(a.harness).not.toBe(b.harness);
  });
});
