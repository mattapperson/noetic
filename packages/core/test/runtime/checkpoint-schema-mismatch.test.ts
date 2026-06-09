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
  it('load throws NoeticConfigError(CHECKPOINT_SCHEMA_MISMATCH) for a v0 snapshot', async () => {
    const storage = createInMemoryStorage();
    await storage.set(`${CheckpointKeys.ExecPrefix}exec-0${CheckpointKeys.SnapshotSuffix}`, {
      schemaVersion: 0,
      executionId: 'exec-0',
    });
    const store = createCheckpointStore({
      storage,
    });
    let thrown: unknown;
    try {
      await store.load('exec-0');
    } catch (err) {
      thrown = err;
    }
    expect(isNoeticConfigError(thrown)).toBe(true);
    if (isNoeticConfigError(thrown)) {
      expect(thrown.code).toBe('CHECKPOINT_SCHEMA_MISMATCH');
    }
  });

  it('load throws for a v2 snapshot (forward-incompatible)', async () => {
    const storage = createInMemoryStorage();
    await storage.set(`${CheckpointKeys.ExecPrefix}exec-2${CheckpointKeys.SnapshotSuffix}`, {
      schemaVersion: 2,
      executionId: 'exec-2',
    });
    const store = createCheckpointStore({
      storage,
    });
    let thrown: unknown;
    try {
      await store.load('exec-2');
    } catch (err) {
      thrown = err;
    }
    expect(isNoeticConfigError(thrown)).toBe(true);
  });

  it('load throws for a malformed snapshot (missing required fields)', async () => {
    const storage = createInMemoryStorage();
    await storage.set(`${CheckpointKeys.ExecPrefix}broken${CheckpointKeys.SnapshotSuffix}`, {
      schemaVersion: 1,
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
