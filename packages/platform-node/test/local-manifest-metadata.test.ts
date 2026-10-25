/**
 * Local adapter step manifests keep caller-supplied `metadata` tags and the
 * parent execution id, and rehydrated handles carry both.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StepSubprocessRequest, SubprocessHandle } from '@noetic-tools/core';
import { createInMemoryStorage } from '@noetic-tools/core';
import {
  hydrateFromManifest,
  loadLocalManifest,
  persistStepIfDurable,
} from '../src/local-subprocess/manifest-persistence';
import type { ProcessSignaller } from '../src/local-subprocess/types';

const aliveSignaller: ProcessSignaller = {
  kill: () => {},
  isAlive: () => true,
  startTime: () => 'start-1',
};

describe('local step manifest', () => {
  it('persists metadata tags and parentExecutionId and restores them on hydrate', async () => {
    const storage = createInMemoryStorage();
    const request: StepSubprocessRequest = {
      kind: 'step',
      stepId: 'plan',
      serializedInput: null,
      executionId: 'exec-child',
      parentExecutionId: 'exec-parent',
      overrides: {},
      metadata: {
        taskRole: 'planner',
        taskId: 'T-1',
        runtime: 'spoofed',
      },
    };
    const handle: SubprocessHandle = {
      id: 'local-1',
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    await persistStepIfDurable({
      storage,
      request,
      handle,
      pid: 4242,
      pidStarttime: 'start-1',
    });

    const manifest = await loadLocalManifest(storage, 'local-1');
    assert(manifest !== null && manifest.kind === 'step');
    expect(manifest.metadata).toEqual({
      taskRole: 'planner',
      taskId: 'T-1',
      runtime: 'spoofed',
    });
    expect(manifest.parentExecutionId).toBe('exec-parent');

    const rehydrated = hydrateFromManifest(manifest, aliveSignaller);
    assert(rehydrated !== null);
    expect(rehydrated.metadata?.taskRole).toBe('planner');
    expect(rehydrated.metadata?.taskId).toBe('T-1');
    expect(rehydrated.metadata?.executionId).toBe('exec-child');
    expect(rehydrated.metadata?.parentExecutionId).toBe('exec-parent');
    // Caller tags never shadow the adapter's own keys.
    expect(rehydrated.metadata?.runtime).toBe('local');
  });
});
