/**
 * End-to-end check of specs 35 and 37 across packages: the real `AgentHarness`
 * and connection registry from `@noetic-tools/core`, the real verifier from
 * `@noetic-tools/verify`, and an in-memory connection standing in for a
 * browser server. Core and verify never import each other (sentrux
 * boundaries), so this file is where they meet.
 *
 * Run: `bun run example:verify`. Exits non-zero when a check fails.
 */

import assert from 'node:assert';
import type { InMemoryConnectionProvider } from '@noetic-tools/core';
import { AgentHarness, createInMemoryConnection, step } from '@noetic-tools/core';
import { net, verifier } from '@noetic-tools/verify';

//#region Fixtures

const ORDER_CREATED = {
  summary: 'POST /api/orders 201',
  method: 'POST',
  status: 201,
} as const;

/** A browser-like connection: `ui.tap` has effects and, when `orders` is true, the app answers with a request. */
function shop(orders: boolean): InMemoryConnectionProvider {
  return createInMemoryConnection({
    surface: 'web',
    senses: {
      net: {
        independence: 'independent',
        grade: 'consequence',
      },
    },
    events: {
      'browser.request': {
        sense: 'net',
        replay: 'live',
      },
    },
    operations: {
      'ui.tap': {
        effects: true,
        run: (_args, call) => {
          if (orders) {
            call.connection.emit('browser.request', ORDER_CREATED);
          }
          return {
            receipt: {
              ok: true,
            },
          };
        },
      },
    },
  });
}

async function checkout(orders: boolean): Promise<string> {
  const harness = new AgentHarness({
    name: 'verify-e2e',
    params: {},
    connections: {
      app: shop(orders),
    },
    verification: verifier(),
  });
  try {
    const ctx = harness.createContext();
    const output = await harness.run(
      step.verify({
        id: 'checkout',
        subject: 'app',
        intent: 'Paying places an order',
        expect: [
          net('POST /api/orders 201').once(),
        ],
        act: step.call({
          id: 'pay',
          connection: 'app',
          op: 'ui.tap',
        }),
        close: {
          quietMs: 50,
          timeoutMs: 2e3,
        },
      }),
      undefined,
      ctx,
    );
    const runItem = ctx.itemLog.items.find((item) => item.type === 'noetic:verification_run');
    assert(runItem, 'the verify step emits a noetic:verification_run item');
    const artifacts = await harness.artifacts.listRun(ctx.id);
    assert(artifacts.length > 0, 'the verification run is stored as a run artifact');
    return output.outcome;
  } finally {
    await harness.close();
  }
}

//#endregion

//#region Main

const passing = await checkout(true);
console.log(`order placed  → ${passing}`);
assert.equal(passing, 'pass');

const failing = await checkout(false);
console.log(`no order sent → ${failing}`);
assert.notEqual(failing, 'pass');

console.log('verify-e2e: ok');

//#endregion
