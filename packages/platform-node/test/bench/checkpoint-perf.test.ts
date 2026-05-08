/**
 * Checkpoint overhead benchmark.
 *
 * Measures the per-snapshot wall time at the p50 using the file-backed
 * StorageAdapter — the CheckpointStore backing most CLI production
 * deployments will use. The plan budget is 5 ms per snapshot at p50; if
 * this number grows, consider adding a `checkpointDebounceMs` option on
 * AgentHarnessOpts that coalesces fires within the window.
 *
 * The test is opt-in so slow CI boxes don't flake against a hard budget;
 * run with `NOETIC_RUN_BENCH=1 bun test <this file>`. The assertion is
 * lenient (20 ms) so a shared-CI runner doesn't hit thermal throttling
 * false positives; the meaningful signal is the logged numbers, which
 * the author reviews at commit time.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHarness, createCheckpointStore } from '@noetic/core';
import { createFileStorage } from '../../src/file-storage';

const ITERATIONS = 200;
const P50_BUDGET_MS = 20;

const SHOULD_RUN = process.env.NOETIC_RUN_BENCH === '1';

describe.skipIf(!SHOULD_RUN)('checkpoint perf (file-backed)', () => {
  it(`per-snapshot p50 is under ${P50_BUDGET_MS}ms`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'noetic-bench-'));
    try {
      const storage = createFileStorage({
        root,
      });
      const checkpointStore = createCheckpointStore({
        storage,
      });
      const harness = new AgentHarness({
        name: 'benchHarness',
        params: {},
        storage,
        checkpointStore,
      });
      const ctx = harness.createContext({});
      const samples: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        await harness.checkpoint(ctx);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      const p50 = samples[Math.floor(samples.length / 2)] ?? 0;
      const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
      const max = samples[samples.length - 1] ?? 0;
      console.log(
        `checkpoint p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  max=${max.toFixed(2)}ms  n=${ITERATIONS}`,
      );
      expect(p50).toBeLessThan(P50_BUDGET_MS);
    } finally {
      rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  });
});
