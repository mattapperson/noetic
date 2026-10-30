/**
 * QA script 3 (spec 37): `step.verify` with the real `verifier()` from
 * `@noetic-tools/verify`, producing pass, fail (a broken `never`), unknown
 * (a gap, and a claim already true before the action), a failing `act`, and a
 * list subject — then reading each run record back from the artifact store and
 * recomputing its outcome with OVP's own `outcomeOf()`.
 *
 * Run: `bun examples/connections/verify-outcomes.ts`. Exits non-zero when a check fails.
 */

import { join } from 'node:path';
import type {
  Context,
  ContextData,
  InMemoryConnectionProvider,
  InMemoryOperation,
  Step,
  VerifyOpts,
} from '@noetic-tools/core';
import {
  AgentHarness,
  createInMemoryConnection,
  inMemoryRefusal,
  parseAndRunWorkflow,
  step,
} from '@noetic-tools/core';
import { mcp } from '@noetic-tools/mcp';
import * as verify from '@noetic-tools/verify';
import { event, net, verifier } from '@noetic-tools/verify';
import { z } from 'zod';
import { ui } from '../../packages/profile-ui/src/index';
import type { VerifyOutput } from '../../packages/types/src/verify/index';
import {
  outcomeOf,
  VerificationRunSchema,
} from '../../packages/verify/node_modules/open-verification/dist/index.js';
import type { Settled } from './_qa';
import { check, finish, SERVER_PATH, scratchDir, section, settle, show } from './_qa';

//#region Fixtures

type Behavior = 'order' | 'error' | 'nothing' | 'gap' | 'refuse';

const ORDER = {
  summary: 'POST /api/orders 201',
  method: 'POST',
  status: 201,
};

const SERVER_ERROR = {
  summary: 'POST /api/orders 500',
  method: 'POST',
  status: 500,
};

function shop(
  behavior: Behavior,
  ordersBefore: ReadonlyArray<typeof ORDER> = [],
): InMemoryConnectionProvider {
  const pay: InMemoryOperation = {
    effects: true,
    run: (_args, call) => {
      if (behavior === 'refuse') {
        throw inMemoryRefusal('unavailable', 'the Pay button is disabled');
      }
      if (behavior === 'order') {
        call.connection.emit('browser.request', ORDER);
      }
      if (behavior === 'error') {
        call.connection.emit('browser.request', ORDER);
        call.connection.emit('browser.request', SERVER_ERROR);
      }
      if (behavior === 'gap') {
        call.connection.gap('listener overflowed', 'browser.request');
      }
      return {
        receipt: {
          actionId: `act-${crypto.randomUUID()}`,
          cursor: null,
        },
      };
    },
  };
  return createInMemoryConnection({
    surface: 'web',
    profiles: {
      ui: '1.0.0',
    },
    senses: {
      net: {
        independence: 'independent',
        grade: 'consequence',
      },
      log: {
        independence: 'independent',
        grade: 'context',
      },
    },
    events: {
      'browser.request': {
        sense: 'net',
        replay: 'live',
      },
      'device.app.crashed': {
        sense: 'log',
        replay: 'live',
      },
    },
    resources: {
      'browser.requests': {
        sense: 'net',
        read: () => ordersBefore,
      },
    },
    operations: {
      'ui.tap': pay,
      'ui.find': {
        run: () => ({
          elements: [],
        }),
      },
    },
  });
}

function harnessFor(connections: Record<string, InMemoryConnectionProvider>): AgentHarness {
  return new AgentHarness({
    name: 'qa-verify',
    params: {},
    connections,
    verification: verifier(),
  });
}

const OutputSchema = z.looseObject({
  outcome: z.enum([
    'pass',
    'fail',
    'partial',
    'unknown',
  ]),
  verdicts: z.array(
    z.looseObject({
      claim: z.string(),
      verdict: z.string(),
      ground: z.string(),
      reasons: z.array(z.string()),
    }),
  ),
  violations: z.array(z.unknown()),
  gaps: z.array(z.unknown()),
  run: z.object({
    $blob: z.object({
      uri: z.string(),
    }),
  }),
});

type VerifyOut = z.infer<typeof OutputSchema>;

function checkout(
  id: string,
  extra: Partial<VerifyOpts> = {},
): Step<ContextData, unknown, VerifyOutput> {
  return step.verify({
    id,
    subject: 'app',
    intent: 'Paying places an order',
    expect: [
      net('POST /api/orders 201').once(),
    ],
    never: [
      net('5xx'),
    ],
    act: step.call({
      id: `${id}-pay`,
      connection: 'app',
      op: 'ui.tap',
      args: {
        element: 'button "Pay"',
      },
    }),
    close: {
      quietMs: 50,
      timeoutMs: 2e3,
    },
    ...extra,
  });
}

async function runVerify(
  harness: AgentHarness,
  verifyStep: Step<ContextData, unknown, VerifyOutput>,
): Promise<{
  settled: Settled;
  out?: VerifyOut;
  ctx: Context;
}> {
  const ctx = harness.createContext();
  const settled = await settle(harness.run(verifyStep, undefined, ctx));
  if (!settled.ok) {
    return {
      settled,
      ctx,
    };
  }
  return {
    settled,
    out: OutputSchema.parse(settled.value),
    ctx,
  };
}

/** Reads a run record from the artifact store and checks it with OVP itself. */
interface RecordCheck {
  readonly harness: AgentHarness;
  readonly label: string;
  readonly out: VerifyOut;
  readonly ctx: Context;
}

async function checkRecord({ harness, label, out, ctx }: RecordCheck): Promise<void> {
  const stream = await harness.artifacts.get(out.run.$blob.uri);
  check(`${label}: the run document is in the artifact store`, stream !== null);
  if (stream === null) {
    return;
  }
  const text = await new Response(stream).text();
  const parsed = VerificationRunSchema.safeParse(JSON.parse(text));
  check(
    `${label}: the run document is a valid OVP VerificationRun`,
    parsed.success,
    parsed.success ? '' : parsed.error.message,
  );
  if (!parsed.success) {
    return;
  }
  const run = parsed.data;
  check(
    `${label}: OVP outcomeOf(run) recomputes the same outcome (OVP-VERDICT-4)`,
    outcomeOf(run) === out.outcome,
    `outcomeOf=${outcomeOf(run)} step=${out.outcome}`,
  );
  check(
    `${label}: the intent is kept in the run record`,
    JSON.stringify(run.intents).includes('Paying places an order'),
  );
  const firstAction = Math.min(
    ...run.actions.map((a) =>
      Number(JSON.stringify(a).match(/"at":(\d+)/)?.[1] ?? Number.POSITIVE_INFINITY),
    ),
  );
  check(
    `${label}: claims are declared before the action (OVP-INTENT-3)`,
    run.claims.length > 0 &&
      run.claims.every((c) => JSON.stringify(c).length > 0) &&
      run.startedAt <= firstAction,
    {
      startedAt: run.startedAt,
      firstAction,
    },
  );
  const item = ctx.itemLog.items.find((i) => i.type === 'noetic:verification_run');
  check(`${label}: a noetic:verification_run item is emitted`, item !== undefined);
  const artifacts = await harness.artifacts.listRun(ctx.id);
  check(
    `${label}: the run is attached to the execution's artifacts`,
    artifacts.some((a) => JSON.stringify(a).includes(out.run.$blob.uri)),
    artifacts,
  );
}

//#endregion

await section('pass: the action produces the expected request', async () => {
  const harness = harnessFor({
    app: shop('order'),
  });
  try {
    const { settled, out, ctx } = await runVerify(harness, checkout('pass'));
    check('verify answers', settled.ok, show(settled));
    check('outcome is pass', out?.outcome === 'pass', out);
    check('the claim verdict is yes', out?.verdicts[0]?.verdict === 'yes', out?.verdicts);
    if (out) {
      await checkRecord({
        harness,
        label: 'pass',
        out,
        ctx,
      });
    }
  } finally {
    await harness.close();
  }
});

await section('fail: a never is broken even though the claim holds', async () => {
  const harness = harnessFor({
    app: shop('error'),
  });
  try {
    const { settled, out, ctx } = await runVerify(harness, checkout('fail'));
    check('verify answers (a no is an answer, not a throw)', settled.ok, show(settled));
    check('outcome is fail (OVP-INTENT-8)', out?.outcome === 'fail', out);
    check('the violation is recorded', (out?.violations.length ?? 0) > 0, out?.violations);
    if (out) {
      await checkRecord({
        harness,
        label: 'fail',
        out,
        ctx,
      });
    }
  } finally {
    await harness.close();
  }
});

await section('fail: nothing happens at all', async () => {
  const harness = harnessFor({
    app: shop('nothing'),
  });
  try {
    const { out } = await runVerify(harness, checkout('nothing'));
    check('outcome is not pass', out !== undefined && out.outcome !== 'pass', out);
    console.log(
      `      outcome ${out?.outcome}, verdict ${out?.verdicts[0]?.verdict} (${out?.verdicts[0]?.ground})`,
    );
  } finally {
    await harness.close();
  }
});

await section('unknown: a gap on the claimed sense', async () => {
  const harness = harnessFor({
    app: shop('gap'),
  });
  try {
    const { settled, out, ctx } = await runVerify(harness, checkout('gap'));
    check('verify answers', settled.ok, show(settled));
    check('outcome is unknown', out?.outcome === 'unknown', out);
    check(
      'the gap is reported as buffer-truncated or channel-unobserved',
      JSON.stringify(out?.gaps ?? []).match(/buffer-truncated|channel-unobserved/) !== null,
      out?.gaps,
    );
    if (out) {
      await checkRecord({
        harness,
        label: 'gap',
        out,
        ctx,
      });
    }
  } finally {
    await harness.close();
  }
});

await section('unknown: the claim already held before the action', async () => {
  const harness = harnessFor({
    app: shop('order', [
      ORDER,
    ]),
  });
  try {
    const { settled, out } = await runVerify(harness, checkout('before'));
    check('verify answers', settled.ok, show(settled));
    check('outcome is unknown (OVP clause 10)', out?.outcome === 'unknown', out);
    console.log(
      `      verdict ${out?.verdicts[0]?.verdict} (${out?.verdicts[0]?.ground}): ${out?.verdicts[0]?.reasons.join('; ')}`,
    );
  } finally {
    await harness.close();
  }
});

await section(
  'a list subject (JSON) runs one verify per connection with the worst outcome',
  async () => {
    const harness = harnessFor({
      ios: shop('order'),
      android: shop('error'),
    });
    try {
      const settled = await settle(
        parseAndRunWorkflow({
          json: {
            version: 1,
            connections: {
              ios: {
                profile: 'ui@^1',
              },
              android: {
                profile: 'ui@^1',
              },
            },
            root: {
              kind: 'verify',
              id: 'both',
              subject: [
                'ios',
                'android',
              ],
              expect: [
                {
                  net: 'POST /api/orders 201',
                },
              ],
              never: [
                {
                  net: '5xx',
                },
              ],
              act: [
                {
                  'ui.tap': {
                    element: 'button "Pay"',
                  },
                },
              ],
              close: {
                quietMs: 50,
                timeoutMs: 2e3,
              },
            },
          },
          harness,
          ctx: harness.createContext(),
          tools: [],
        }),
      );
      console.log(`      ${show(settled).slice(0, 300)}`);
      const value = settled.ok ? String(settled.value) : '';
      check('a JSON verify over [ios, android] runs', settled.ok, show(settled));
      check(
        "the combined outcome is the worst one — pass on ios, fail on android → 'fail' (spec 37: 'the worst outcome')",
        value.includes('"outcome":"fail"') && !value.includes('"outcome":"partial"'),
        value.slice(0, 200),
      );
      check(
        'each subject has its own result',
        value.includes('"ios"') && value.includes('"android"'),
        value.slice(0, 400),
      );
    } finally {
      await harness.close();
    }
  },
);

await section('act throws: verify_act_failed, run still recorded', async () => {
  const harness = harnessFor({
    app: shop('refuse'),
  });
  try {
    const ctx = harness.createContext();
    const settled = await settle(harness.run(checkout('refused'), undefined, ctx));
    check(
      'the step fails with verify_act_failed',
      !settled.ok && settled.kind === 'verify_act_failed',
      show(settled),
    );
    check(
      'the error carries the recorded run',
      !settled.ok && JSON.stringify(settled.message).includes('artifact://'),
      show(settled),
    );
    const item = ctx.itemLog.items.find((i) => i.type === 'noetic:verification_run');
    check('a noetic:verification_run item is still emitted', item !== undefined);
  } finally {
    await harness.close();
  }
});

await section('event matcher and validation errors', async () => {
  const harness = harnessFor({
    app: shop('order'),
  });
  try {
    const crashed = await runVerify(
      harness,
      step.verify({
        id: 'crash',
        subject: 'app',
        expect: [
          net('POST /api/orders 201'),
        ],
        never: [
          event('device.app.crashed'),
        ],
        act: step.call({
          id: 'pay',
          connection: 'app',
          op: 'ui.tap',
          args: {
            element: 'button "Pay"',
          },
        }),
        close: {
          quietMs: 50,
          timeoutMs: 2e3,
        },
      }),
    );
    check(
      'an event matcher in never is accepted and passes when no crash',
      crashed.out?.outcome === 'pass',
      show(crashed.settled),
    );
    const blind = await runVerify(
      harness,
      checkout('blind', {
        expect: [
          verify.ui('heading "Order confirmed"'),
        ],
      }),
    );
    check(
      'a matcher on a sense the subject cannot perceive fails with CONNECTION_UNSATISFIED',
      !blind.settled.ok && blind.settled.code === 'CONNECTION_UNSATISFIED',
      show(blind.settled),
    );
    const noEffects = await runVerify(
      harness,
      checkout('no-effects', {
        act: step.call({
          id: 'look',
          connection: 'app',
          op: 'ui.find',
          args: {
            query: 'Pay',
          },
        }),
      }),
    );
    check(
      'an act with no operation with effects fails with VERIFY_INVALID',
      !noEffects.settled.ok && noEffects.settled.code === 'VERIFY_INVALID',
      show(noEffects.settled),
    );
    const bad = await settle(
      (async (): Promise<unknown> =>
        runVerify(
          harness,
          checkout('bad-matcher', {
            expect: [
              net('NOT A METHOD ???'),
            ],
          }),
        ).then((r) => (r.settled.ok ? r.settled.value : Promise.reject(r.settled.error))))(),
    );
    check(
      'a matcher the net grammar cannot parse fails with VERIFY_INVALID',
      !bad.ok && bad.code === 'VERIFY_INVALID',
      show(bad),
    );
  } finally {
    await harness.close();
  }
  const bare = new AgentHarness({
    name: 'qa-verify-none',
    params: {},
    connections: {
      app: shop('order'),
    },
  });
  try {
    const none = await runVerify(bare, checkout('none'));
    check(
      'a harness with no verifier fails with VERIFY_NOT_CONFIGURED',
      !none.settled.ok && none.settled.code === 'VERIFY_NOT_CONFIGURED',
      show(none.settled),
    );
  } finally {
    await bare.close();
  }
});

await section('over MCP: verify against the stdio ui@1 server', async () => {
  const dir = scratchDir('verify-mcp');
  const harness = new AgentHarness({
    name: 'qa-verify-mcp',
    params: {},
    connections: {
      app: mcp({
        command: 'bun',
        args: [
          SERVER_PATH,
        ],
        env: {
          UI_SERVER_LOG: join(dir, 'calls.jsonl'),
        },
        profiles: [
          ui,
        ],
      }),
    },
    verification: verifier(),
  });
  try {
    const ctx = harness.createContext();
    const settled = await settle(
      harness.run(
        step.verify({
          id: 'welcome',
          subject: 'app',
          expect: [
            verify.ui('heading "Welcome"'),
          ],
          act: step.call({
            id: 'sign-in',
            connection: 'app',
            op: 'ui.tap',
            args: {
              element: 'button "Sign in"',
            },
          }),
          close: {
            quietMs: 100,
            timeoutMs: 3e3,
          },
        }),
        undefined,
        ctx,
      ),
    );
    check('verify over a real MCP connection answers', settled.ok, show(settled));
    console.log(`      ${show(settled)}`);
  } finally {
    await harness.close();
  }
});

finish('verify-outcomes');
