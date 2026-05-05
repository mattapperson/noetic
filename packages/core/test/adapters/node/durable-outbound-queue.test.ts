/**
 * DurableOutboundQueue unit tests — verify the transport primitive in
 * isolation without needing a real IPC server.
 *
 * Invariants covered:
 *   1. append() assigns monotonic seqs and persists frames.
 *   2. frameRange(startSeq) returns every un-acked frame with seq >= startSeq,
 *      ordered by seq ascending.
 *   3. ackUpTo(seq) deletes frames at/below the watermark and advances
 *      lastAckedSeq.
 *   4. Re-hydration from the same storage picks up exactly where the
 *      prior instance left off (persistence survives drop + restart).
 *   5. clear() wipes frames + meta.
 */

import { describe, expect, it } from 'bun:test';
import { createDurableOutboundQueue } from '../../../src/adapters/node/durable-outbound-queue';
import { createInMemoryStorage } from '../../../src/runtime/in-memory-storage';

describe('DurableOutboundQueue', () => {
  it('append assigns monotonic seqs starting from 1', async () => {
    const storage = createInMemoryStorage();
    const queue = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/s1',
    });
    const e1 = await queue.append('frame-a');
    const e2 = await queue.append('frame-b');
    const e3 = await queue.append('frame-c');
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
    expect(queue.getHeadSeq()).toBe(3);
    expect(queue.getLastAckedSeq()).toBe(0);
  });

  it('frameRange replays every unacked frame from startSeq onwards in order', async () => {
    const storage = createInMemoryStorage();
    const queue = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/replay',
    });
    await queue.append('a');
    await queue.append('b');
    await queue.append('c');
    const all = await queue.frameRange(1);
    expect(all.map((e) => e.frame)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const partial = await queue.frameRange(2);
    expect(partial.map((e) => e.frame)).toEqual([
      'b',
      'c',
    ]);
  });

  it('ackUpTo deletes at/below the watermark and advances lastAckedSeq', async () => {
    const storage = createInMemoryStorage();
    const queue = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/ack',
    });
    await queue.append('a');
    await queue.append('b');
    await queue.append('c');
    await queue.append('d');
    expect(await queue.queueSize()).toBe(4);
    await queue.ackUpTo(2);
    expect(queue.getLastAckedSeq()).toBe(2);
    expect(await queue.queueSize()).toBe(2);
    const remaining = await queue.frameRange(1);
    expect(remaining.map((e) => e.frame)).toEqual([
      'c',
      'd',
    ]);
  });

  it('ackUpTo clamps to headSeq so a buggy peer can not ack unacked seqs', async () => {
    const storage = createInMemoryStorage();
    const queue = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/clamp',
    });
    await queue.append('a');
    await queue.ackUpTo(999);
    expect(queue.getLastAckedSeq()).toBe(1);
    expect(await queue.queueSize()).toBe(0);
  });

  it('ackUpTo ignores watermarks at or below the current ack', async () => {
    const storage = createInMemoryStorage();
    const queue = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/noop',
    });
    await queue.append('a');
    await queue.append('b');
    await queue.ackUpTo(2);
    expect(queue.getLastAckedSeq()).toBe(2);
    await queue.ackUpTo(1);
    expect(queue.getLastAckedSeq()).toBe(2);
  });

  it('re-hydrates from storage so a fresh queue continues from the prior head seq', async () => {
    const storage = createInMemoryStorage();
    const first = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/persist',
    });
    await first.append('a');
    await first.append('b');
    const second = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/persist',
    });
    expect(second.getHeadSeq()).toBe(2);
    const next = await second.append('c');
    expect(next.seq).toBe(3);
    const replay = await second.frameRange(1);
    expect(replay.map((e) => e.frame)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('isolates namespaces by socketPath so two queues on the same storage do not collide', async () => {
    const storage = createInMemoryStorage();
    const a = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/a',
    });
    const b = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/b',
    });
    await a.append('a1');
    await a.append('a2');
    await b.append('b1');
    expect(a.getHeadSeq()).toBe(2);
    expect(b.getHeadSeq()).toBe(1);
    const aFrames = await a.frameRange(1);
    const bFrames = await b.frameRange(1);
    expect(aFrames.map((e) => e.frame)).toEqual([
      'a1',
      'a2',
    ]);
    expect(bFrames.map((e) => e.frame)).toEqual([
      'b1',
    ]);
  });

  it('clear wipes every persisted frame + meta', async () => {
    const storage = createInMemoryStorage();
    const queue = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/clear',
    });
    await queue.append('a');
    await queue.append('b');
    await queue.clear();
    expect(queue.getHeadSeq()).toBe(0);
    expect(queue.getLastAckedSeq()).toBe(0);
    expect(await queue.queueSize()).toBe(0);

    // A fresh queue on the same storage + socketPath starts clean.
    const next = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/clear',
    });
    expect(next.getHeadSeq()).toBe(0);
  });

  it('queueSize reflects only frames above the ack watermark', async () => {
    const storage = createInMemoryStorage();
    const queue = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/size',
    });
    await queue.append('a');
    await queue.append('b');
    await queue.append('c');
    expect(await queue.queueSize()).toBe(3);
    await queue.ackUpTo(1);
    expect(await queue.queueSize()).toBe(2);
    await queue.ackUpTo(3);
    expect(await queue.queueSize()).toBe(0);
  });
});

describe('DurableOutboundQueue + IPC resume semantics (zero-dup-zero-loss)', () => {
  it('a reconnecting client replays only frames past its acked watermark', async () => {
    // Simulated client journey:
    //   1. Server appends 5 frames. Client has delivered through seq=3.
    //   2. Connection drops.
    //   3. Client reconnects; emits `durableResume(ackedThrough=3)`.
    //   4. Server replays via `frameRange(4)` — returns frames 4, 5 only.
    //   5. No duplicates of 1-3, no loss of 4-5.
    const storage = createInMemoryStorage();
    const serverQueue = await createDurableOutboundQueue({
      storage,
      socketPath: '/tmp/resume',
    });
    for (let i = 1; i <= 5; i++) {
      await serverQueue.append(`frame-${i}`);
    }
    // Client pretends to have acked through 3.
    await serverQueue.ackUpTo(3);

    // Reconnect — server receives durableResume(ackedThrough=3); replay.
    const replay = await serverQueue.frameRange(4);
    expect(replay.map((e) => e.frame)).toEqual([
      'frame-4',
      'frame-5',
    ]);

    // No duplication: the resume request is idempotent against storage.
    const replayAgain = await serverQueue.frameRange(4);
    expect(replayAgain.map((e) => e.frame)).toEqual([
      'frame-4',
      'frame-5',
    ]);
  });
});
