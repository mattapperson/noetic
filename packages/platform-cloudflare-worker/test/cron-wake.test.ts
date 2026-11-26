import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createD1Storage, cronWake } from '../src';
import { fakeD1 } from './_helpers';

const cron = '* * * * *';

test('one scan covers duplicate, concurrent, and older ticks across Workers', async () => {
  const storage = createD1Storage({
    database: fakeD1(new Database(':memory:')),
  });
  const scanned: number[] = [];
  const options = {
    cron,
    name: 'jobs',
    storage: () => storage,
    run: async (_env: undefined, through: number) => {
      scanned.push(through);
    },
  };
  const tick = {
    cron,
    scheduledTime: 180_000,
  };
  await Promise.all([
    cronWake(options)(tick, undefined),
    cronWake(options)(tick, undefined),
  ]);
  await cronWake(options)(tick, undefined);
  await cronWake(options)(
    {
      cron,
      scheduledTime: 120_000,
    },
    undefined,
  );
  expect(scanned).toEqual([
    180_000,
  ]);
});

test('a failed scan can retry the same tick in a fresh Worker', async () => {
  const storage = createD1Storage({
    database: fakeD1(new Database(':memory:')),
  });
  const options = {
    cron,
    name: 'jobs',
    storage: () => storage,
  };
  const tick = {
    cron,
    scheduledTime: 180_000,
  };
  const failed = cronWake({
    ...options,
    run: async () => {
      throw new Error('offline');
    },
  });
  await expect(failed(tick, undefined)).rejects.toThrow('offline');
  const scanned: number[] = [];
  await cronWake({
    ...options,
    run: async (_env: undefined, through: number) => {
      scanned.push(through);
    },
  })(tick, undefined);
  expect(scanned).toEqual([
    180_000,
  ]);
});

test('a later tick can take over after a lost Worker', async () => {
  const storage = createD1Storage({
    database: fakeD1(new Database(':memory:')),
  });
  await storage.set('noetic/cron/jobs', {
    done: 60_000,
    lease: {
      id: 'lost-worker',
      until: 180_000,
    },
  });
  let now = 120_000;
  const scanned: number[] = [];
  const wake = cronWake({
    cron,
    name: 'jobs',
    storage: () => storage,
    now: () => now,
    run: async (_env: undefined, through: number) => {
      scanned.push(through);
    },
  });
  await wake(
    {
      cron,
      scheduledTime: now,
    },
    undefined,
  );
  now = 180_000;
  await wake(
    {
      cron,
      scheduledTime: now,
    },
    undefined,
  );
  expect(scanned).toEqual([
    180_000,
  ]);
});
