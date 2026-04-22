import { describe, expect, test } from 'bun:test';
import { createStreamIdleWatchdog } from '../../src/runtime/agent-harness';
import { sleep } from '../_helpers';

describe('createStreamIdleWatchdog', () => {
  test('fires onTimeout and aborts the controller when idle exceeds deadline', async () => {
    const controller = new AbortController();
    let stalled = false;
    const watchdog = createStreamIdleWatchdog(30, controller, () => {
      stalled = true;
    });
    await sleep(80);
    watchdog.stop();
    expect(stalled).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  test('reset() postpones the deadline so a live stream is not aborted', async () => {
    const controller = new AbortController();
    let stalled = false;
    const watchdog = createStreamIdleWatchdog(50, controller, () => {
      stalled = true;
    });
    // Three resets at 25ms intervals — well under the 50ms idle deadline each
    // time — means the watchdog must not fire during this window.
    for (let i = 0; i < 3; i++) {
      await sleep(25);
      watchdog.reset();
    }
    watchdog.stop();
    await sleep(80);
    expect(stalled).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  test('stop() cancels the timer even if deadline would have fired', async () => {
    const controller = new AbortController();
    let stalled = false;
    const watchdog = createStreamIdleWatchdog(20, controller, () => {
      stalled = true;
    });
    watchdog.stop();
    await sleep(60);
    expect(stalled).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  test('timeoutMs <= 0 returns an inert watchdog that never fires', async () => {
    const controller = new AbortController();
    let stalled = false;
    const inert = createStreamIdleWatchdog(0, controller, () => {
      stalled = true;
    });
    inert.reset();
    inert.stop();
    await sleep(40);
    expect(stalled).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  test('boundary: timeoutMs = 1 produces a live (not inert) watchdog', async () => {
    // Cross the 0/1 boundary of the `<= 0` guard: 1ms must arm a real timer
    // so callers can't accidentally disable the watchdog with a tiny value.
    const controller = new AbortController();
    let stalled = false;
    createStreamIdleWatchdog(1, controller, () => {
      stalled = true;
    });
    await sleep(40);
    expect(stalled).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  test('boundary: timeoutMs = -1 is treated as inert', async () => {
    const controller = new AbortController();
    let stalled = false;
    createStreamIdleWatchdog(-1, controller, () => {
      stalled = true;
    });
    await sleep(40);
    expect(stalled).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  test('onTimeout runs before the abort fires, so callers can capture the reason', async () => {
    const controller = new AbortController();
    let abortedWhenCallbackRan: boolean | undefined;
    createStreamIdleWatchdog(20, controller, () => {
      // If onTimeout fires *after* abort, observability events would be stamped
      // with an already-aborted state and confuse a retry/debug path.
      abortedWhenCallbackRan = controller.signal.aborted;
    });
    await sleep(60);
    expect(controller.signal.aborted).toBe(true);
    expect(abortedWhenCallbackRan).toBe(false);
  });
});
