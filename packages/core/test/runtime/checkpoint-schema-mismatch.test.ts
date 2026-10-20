/**
 * Checkpoint schema-version drift surfaces as a typed NoeticConfigError
 * so hosts can discard incompatible snapshots cleanly instead of running
 * on garbage data.
 */

import { describe, expect, it } from 'bun:test';
import { isNoeticConfigError } from '@noetic-tools/types';
import { CheckpointKeys, createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

describe('CheckpointSnapshot schema version', () => {
  it('rejects a v1 snapshot carrying pre-rename layer-id state instead of restoring it silently', async () => {
    // A fully-formed v1 snapshot: every field a v1 writer produced is present
    // and well-shaped, and `layers` is keyed by the pre-rename built-in layer
    // ids. Only the version is stale — so the rejection below is the version
    // gate, not a shape error. Restoring it would replay state under ids no
    // current layer reads, silently dropping working/observational memory.
    const storage = createInMemoryStorage();
    await storage.set(`${CheckpointKeys.ExecPrefix}exec-v1${CheckpointKeys.SnapshotSuffix}`, {
      schemaVersion: 1,
      executionId: 'exec-v1',
      threadId: 't-1',
      resourceId: 'u-1',
      frontier: [
        {
          stepId: 'greet',
          input: 'hi',
        },
      ],
      layers: {
        'working-memory': {
          bullets: [
            'pre-rename working state',
          ],
        },
        'observational-memory': {
          observations: [
            'pre-rename observational state',
          ],
        },
      },
      cwd: {
        current: '/tmp/x',
        previous: null,
      },
      askUser: [],
      itemLog: {
        items: [],
      },
      capturedAt: new Date().toISOString(),
    });
    const store = createCheckpointStore({
      storage,
    });
    let thrown: unknown;
    try {
      await store.load('exec-v1');
    } catch (err) {
      thrown = err;
    }
    expect(isNoeticConfigError(thrown)).toBe(true);
    if (isNoeticConfigError(thrown)) {
      expect(thrown.code).toBe('CHECKPOINT_SCHEMA_MISMATCH');
    }
  });

  it('load throws for a v3 snapshot (forward-incompatible)', async () => {
    const storage = createInMemoryStorage();
    await storage.set(`${CheckpointKeys.ExecPrefix}exec-3${CheckpointKeys.SnapshotSuffix}`, {
      schemaVersion: 3,
      executionId: 'exec-3',
    });
    const store = createCheckpointStore({
      storage,
    });
    let thrown: unknown;
    try {
      await store.load('exec-3');
    } catch (err) {
      thrown = err;
    }
    expect(isNoeticConfigError(thrown)).toBe(true);
    if (isNoeticConfigError(thrown)) {
      expect(thrown.code).toBe('CHECKPOINT_SCHEMA_MISMATCH');
    }
  });

  it('load throws for a malformed snapshot (missing required fields)', async () => {
    const storage = createInMemoryStorage();
    await storage.set(`${CheckpointKeys.ExecPrefix}broken${CheckpointKeys.SnapshotSuffix}`, {
      schemaVersion: 2,
      // Missing everything else
    });
    const store = createCheckpointStore({
      storage,
    });
    let thrown: unknown;
    try {
      await store.load('broken');
    } catch (err) {
      thrown = err;
    }
    expect(isNoeticConfigError(thrown)).toBe(true);
  });
});
