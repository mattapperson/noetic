// Forgetting a thread or an execution on Cloudflare storage that spills (spec 23
// § Forgetting, spec 25 § Values larger than a row): every row core kept goes, and
// with it every object a spilled value left in the blob store.

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import type { ContextData, StorageAdapter } from '@noetic-tools/core';
import { AgentHarness, callModel } from '@noetic-tools/core';
import { createD1Storage } from '../src/d1-storage';
import { createDurableObjectStorage } from '../src/durable-object-storage';
import type { FakeBlobs } from './_helpers';
import { fakeBlobs, fakeD1, fakeObjectSql, model } from './_helpers';

//#region Fixtures

/** Far under one turn's record, so every write of it spills. */
const LIMIT = 256;

interface Made {
  /** Rows and objects shared by every adapter `storage` makes, as Workers of one app share them. */
  storage: () => StorageAdapter;
  blobs: FakeBlobs;
  /** Every stored row's key. */
  rows: () => string[];
}

function rowKeys(db: Database): () => string[] {
  return () =>
    db
      .query('SELECT key FROM noetic_storage ORDER BY key')
      .all()
      .map((row) =>
        typeof row === 'object' && row !== null && 'key' in row ? String(row.key) : '',
      );
}

const adapters: Record<string, () => Made> = {
  D1: () => {
    const db = new Database(':memory:');
    const blobs = fakeBlobs();
    return {
      storage: () =>
        createD1Storage({
          database: fakeD1(db),
          scope: 'alice',
          spill: {
            blobs,
            maxBytes: LIMIT,
          },
        }),
      blobs,
      rows: rowKeys(db),
    };
  },
  'Durable Object SQL': () => {
    const db = new Database(':memory:');
    const blobs = fakeBlobs();
    return {
      storage: () =>
        createDurableObjectStorage({
          sql: fakeObjectSql(db),
          scope: 'alice',
          spill: {
            blobs,
            maxBytes: LIMIT,
          },
        }),
      blobs,
      rows: rowKeys(db),
    };
  },
};

function harnessOver(storage: StorageAdapter): AgentHarness {
  return new AgentHarness({
    name: 'forget',
    params: {},
    interactive: true,
    agentGraph: callModel<ContextData, string, string>({
      id: 'turn',
      model: 'test/model',
    }),
    _testCallModel: model('reply').call,
    environment: {
      storage: {
        adapter: storage,
      },
    },
  });
}

async function runTurn(harness: AgentHarness, threadId: string, text: string): Promise<void> {
  await harness.execute(text, {
    threadId,
  });
  await harness.getAgentResponse({
    threadId,
  });
}

/** A value whose JSON is well over `LIMIT`. */
function big(tag: string): Record<string, string> {
  return {
    tag,
    body: 'x'.repeat(4 * LIMIT),
  };
}

//#endregion

for (const [name, make] of Object.entries(adapters)) {
  describe(`forgetting on ${name} storage that spills`, () => {
    it('deletes a thread’s rows and every object its spilled values left, and nothing of another thread', async () => {
      const made = make();
      const harness = harnessOver(made.storage());
      await runTurn(harness, 'resp_h_1', 'a long message '.repeat(40));
      await runTurn(harness, 'resp_h_1', 'and another '.repeat(40));
      await runTurn(harness, 'resp_h_2', 'someone else '.repeat(40));
      await harness.close();
      const storage = made.storage();
      // A large trail mark and layer state on the thread's first turn, as a long run leaves.
      const [first] =
        (
          await storage.get<{
            executions: string[];
          }>('session:resp_h_1')
        )?.executions ?? [];
      expect(first).toBeDefined();
      await storage.set(`execution:${first}:trail:000009`, big('mark'));
      await storage.set('layers/notes/resp_h_1/state', big('notes'));
      const objectsBefore = made.blobs.objects.size;
      expect(objectsBefore).toBeGreaterThan(0);

      // A new harness, as a sweep in a fresh isolate is, finds the thread by listing.
      const sweeper = harnessOver(made.storage());
      expect(
        await sweeper.listStoredThreads({
          prefix: 'resp_h_',
        }),
      ).toEqual([
        'resp_h_1',
        'resp_h_2',
      ]);
      const report = await sweeper.forget(
        {
          threadId: 'resp_h_1',
        },
        {
          patienceMs: 0,
        },
      );

      expect(report.executionIds).toHaveLength(2);
      const rows = made.rows();
      expect(rows.filter((key) => key.includes('resp_h_1'))).toEqual([]);
      for (const executionId of report.executionIds) {
        expect(rows.filter((key) => key.includes(executionId))).toEqual([]);
      }
      expect(rows.some((key) => key.includes('resp_h_2'))).toBe(true);
      expect(
        [
          ...made.blobs.objects.keys(),
        ].filter((key) => key.includes('resp_h_1') || key.includes(first ?? '')),
      ).toEqual([]);
      expect(made.blobs.objects.size).toBeLessThan(objectsBefore);

      await sweeper.forget(
        {
          threadId: 'resp_h_2',
        },
        {
          patienceMs: 0,
        },
      );
      expect(made.rows()).toEqual([]);
      expect(made.blobs.objects.size).toBe(0);
      expect(await sweeper.listStoredThreads()).toEqual([]);
    });

    it('deletes an execution’s spilled rows and objects', async () => {
      const made = make();
      const storage = made.storage();
      await storage.set('execution:job-1:snapshot', big('snapshot'));
      await storage.set('execution:job-1:trail:000001', big('mark'));
      await storage.set('execution:job-2:trail:000001', big('kept'));
      const harness = harnessOver(made.storage());
      expect(await harness.listStoredExecutions()).toEqual([
        {
          executionId: 'job-1',
          parts: [
            'snapshot',
            'trail',
          ],
          resumable: true,
        },
        {
          executionId: 'job-2',
          parts: [
            'trail',
          ],
          resumable: false,
        },
      ]);

      await harness.forget(
        {
          executionId: 'job-1',
        },
        {
          patienceMs: 0,
        },
      );

      expect(made.rows()).toEqual([
        'execution:job-2:trail:000001',
      ]);
      expect(made.blobs.objects.size).toBe(1);
    });
  });
}
