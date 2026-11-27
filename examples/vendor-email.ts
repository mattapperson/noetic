/**
 * Durable runs, human decisions and event-driven work, end to end (specs 08, 23,
 * 23a and 35), with real processes and a real kill:
 *
 * 1. A vendor's email arrives twice. One case is opened.
 * 2. The executor handling it is killed (`SIGKILL`) in the middle of the run.
 * 3. Another executor picks the turn up. It does not open the case again. It
 *    proposes a payment, which needs a person, and stops holding a process.
 * 4. The next day a reviewer approves the exact action that was proposed. A
 *    changed action is refused. The turn resumes on yet another executor, pays
 *    once and leaves a receipt.
 * 5. The owner changes the rule. A new email is handled by the new version, and
 *    the trail shows which version handled each case.
 *
 * The flow is one `runCode` over `step.call`, a tool marked `needsApproval` and a
 * trigger. Nothing else: no model, no API key.
 *
 * Every executor is its own process, started from this file. They share one
 * SQLite file, which holds Noetic's storage and stands in for the two outside
 * systems (the case tracker and the bank).
 *
 * Run: `bun run example:vendor-email`. Exits non-zero when a check fails.
 */

import { Database } from 'bun:sqlite';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContextData, HarnessResponse, HeldCall, Item, TrailMark } from '@noetic-tools/core';
import {
  AgentHarness,
  createInMemoryConnection,
  defineSource,
  invokeTool,
  isNoeticError,
  runCode,
  step,
  tool,
} from '@noetic-tools/core';
import { createSqliteStorage } from '@noetic-tools/platform-node';
import { z } from 'zod';

//#region The outside world

const DAY_MS = 24 * 36e5;

const EmailSchema = z.object({
  vendor: z.string(),
  invoice: z.string(),
  amount: z.number(),
});
type Email = z.infer<typeof EmailSchema>;

const CaseSchema = z.object({
  caseId: z.string(),
  receipt: z.object({
    actionId: z.string(),
  }),
});

const PaymentSchema = z.object({
  caseId: z.string(),
  vendor: z.string(),
  amount: z.number(),
  memo: z.string(),
});
type Payment = z.infer<typeof PaymentSchema>;

const PaidSchema = z.object({
  paid: z.number(),
  receipt: z.object({
    actionId: z.string(),
  }),
});

/**
 * The case tracker and the bank. Each counts every request it gets in
 * `attempts`, and keeps one row per idempotency key, as a real system that
 * honors idempotency keys does.
 */
function outsideWorld(db: Database) {
  db.exec('CREATE TABLE IF NOT EXISTS attempts (system TEXT NOT NULL, key TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS cases (key TEXT PRIMARY KEY, id TEXT NOT NULL)');
  db.exec(
    'CREATE TABLE IF NOT EXISTS payments (key TEXT PRIMARY KEY, id TEXT NOT NULL, amount REAL NOT NULL)',
  );
  const attempt = db.prepare('INSERT INTO attempts (system, key) VALUES (?, ?)');
  const IdRowSchema = z.object({
    id: z.string(),
  });
  return {
    openCase(key: string, email: Email): string {
      attempt.run('cases', key);
      db.prepare('INSERT INTO cases (key, id) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(
        key,
        `case-${email.invoice}`,
      );
      return IdRowSchema.parse(db.prepare('SELECT id FROM cases WHERE key = ?').get(key)).id;
    },
    pay(key: string, payment: Payment): string {
      attempt.run('bank', key);
      db.prepare(
        'INSERT INTO payments (key, id, amount) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
      ).run(key, `pay-${payment.caseId}`, payment.amount);
      return IdRowSchema.parse(db.prepare('SELECT id FROM payments WHERE key = ?').get(key)).id;
    },
  };
}

//#endregion

//#region The agent

/** The rule the owner changes: v1 pays an invoice in full, v2 holds a tenth back. */
function proposedPayment(version: string, email: Email, caseId: string): Payment {
  const amount = version === 'v1' ? email.amount : Math.round(email.amount * 0.9);
  return {
    caseId,
    vendor: email.vendor,
    amount,
    memo:
      version === 'v1'
        ? `Invoice ${email.invoice}, paid in full`
        : `Invoice ${email.invoice}, 10% retained`,
  };
}

/** The message a turn was started with: the last thing the user side said. */
function turnMessage(items: ReadonlyArray<Item>): string {
  for (const item of items.toReversed()) {
    if (item.type !== 'message' || item.role !== 'user') {
      continue;
    }
    return typeof item.content === 'string'
      ? item.content
      : item.content.map((part) => ('text' in part ? part.text : '')).join('');
  }
  return '';
}

interface ExecutorOptions {
  name: string;
  version: string;
  db: Database;
  /** How far this executor's clock runs ahead of the wall clock. */
  clockOffsetMs: number;
  /** Hang in the vendor lookup, for the executor that is about to be killed. */
  hangInLookup: boolean;
}

function buildExecutor(opts: ExecutorOptions) {
  const world = outsideWorld(opts.db);

  const mail = defineSource({
    events: {
      received: EmailSchema,
    },
  });

  // The case tracker is a connection. `once` says a repeated key is one case.
  const tracker = createInMemoryConnection({
    surface: 'case-tracker',
    instance: 'case-tracker-prod',
    operations: {
      'cases.create': {
        once: true,
        effects: true,
        run: (args, context) => {
          const caseId = world.openCase(context.idempotencyKey, EmailSchema.parse(args));
          return {
            caseId,
            receipt: {
              actionId: caseId,
            },
          };
        },
      },
    },
  });

  // Paying is a tool that needs a person, and must never run twice unasked.
  const payVendor = tool({
    name: 'pay_vendor',
    description: 'Pay a vendor from the operating account.',
    input: PaymentSchema,
    output: PaidSchema,
    needsApproval: true,
    durable: true,
    execute: async (payment, toolCtx) => {
      assert(toolCtx.idempotencyKey);
      return {
        paid: payment.amount,
        receipt: {
          actionId: world.pay(toolCtx.idempotencyKey, payment),
        },
      };
    },
  });

  const openCase = step.call<ContextData, Email>({
    id: 'open-case',
    connection: 'tracker',
    op: 'cases.create',
    args: (email) => email,
  });

  const lookUpVendor = runCode<ContextData, Email, string>({
    id: 'look-up-vendor',
    execute: async (email) => {
      if (opts.hangInLookup) {
        say({
          at: 'lookup',
        });
        // The process is killed while it is in here.
        await new Promise(() => {});
      }
      return `${email.vendor} is a known vendor`;
    },
  });

  const pay = invokeTool({
    id: 'pay',
    tool: payVendor,
  });

  const flow = runCode<ContextData, string, string>({
    id: 'handle-vendor-email',
    execute: async (_input, execCtx) => {
      const email = EmailSchema.parse(JSON.parse(turnMessage(execCtx.itemLog.items)));
      const opened = CaseSchema.parse(await execCtx.harness.run(openCase, email, execCtx));
      await execCtx.harness.run(lookUpVendor, email, execCtx);
      const payment = proposedPayment(opts.version, email, opened.caseId);
      const paid = PaidSchema.parse(await execCtx.harness.run(pay, payment, execCtx));
      return `${opened.caseId}: paid ${paid.paid} to ${email.vendor} (${paid.receipt.actionId})`;
    },
  });

  const harness = new AgentHarness({
    name: 'vendor-desk',
    params: {},
    version: opts.version,
    agentGraph: flow,
    now: () => Date.now() + opts.clockOffsetMs,
    connections: {
      mail,
      tracker,
    },
    // An email becomes a turn on its own thread. The same email twice is one turn.
    triggerTurnOn: [
      {
        id: 'vendor-mail',
        connection: 'mail',
        event: 'received',
        input: 'event.payload',
        thread: '"mail:" & event.id',
      },
    ],
    environment: {
      storage: {
        adapter: createSqliteStorage({
          database: opts.db,
        }),
        lease: {
          holder: opts.name,
          ttlMs: 1500,
        },
        // Each executor is short-lived, like a serverless worker: it parks a
        // waiting turn and leaves, and whoever comes next wakes it.
        park: {
          graceMs: 0,
          autoWake: false,
        },
      },
    },
  });

  return {
    harness,
    mail,
  };
}

//#endregion

//#region Executor processes

/** A line an executor process reports to the script that started it. */
function say(report: Record<string, unknown>): void {
  console.log(`@@${JSON.stringify(report)}`);
}

async function until<T>(read: () => Promise<T | undefined>, what: string, tries = 600): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function heldOn(harness: AgentHarness, threadId: string): Promise<HeldCall> {
  return until(
    async () =>
      (
        await harness.pending({
          threadId,
        })
      )[0],
    `a held call on ${threadId}`,
  );
}

/**
 * The turn's answer once it is no longer parked. `getAgentResponse` answers with
 * the last response while nothing runs, so ask until the turn has moved on.
 */
function paidOn(harness: AgentHarness, threadId: string): Promise<HarnessResponse> {
  return until(async () => {
    const response = await harness.getAgentResponse({
      threadId,
    });
    return response.parked ? undefined : response;
  }, `the turn on ${threadId} to finish`);
}

function summary(trail: TrailMark[]): Array<Record<string, unknown>> {
  return trail
    .filter((mark) => mark.stepId === 'open-case' || mark.stepId === 'pay')
    .map((mark) => ({
      step: mark.stepId,
      version: mark.version,
      holder: mark.holder,
      receipt: mark.receipt,
    }));
}

const EMAILS: Record<
  string,
  {
    id: string;
    payload: Email;
  }
> = {
  first: {
    id: 'msg-1042',
    payload: {
      vendor: 'Acme Paper',
      invoice: '1042',
      amount: 1200,
    },
  },
  second: {
    id: 'msg-2077',
    payload: {
      vendor: 'Northwind Freight',
      invoice: '2077',
      amount: 800,
    },
  },
};

type Role = (opts: ExecutorOptions) => Promise<void>;

const roles: Record<string, Role> = {
  /** The email arrives, twice. This executor is killed while it works. */
  receive: async (opts) => {
    const { harness, mail } = buildExecutor({
      ...opts,
      hangInLookup: true,
    });
    await harness.start();
    const email = EMAILS.first;
    assert(email);
    await mail.emit({
      type: 'received',
      ...email,
    });
    await mail.emit({
      type: 'received',
      ...email,
    });
    await new Promise(() => {});
  },

  /** A new executor finds the cut-off turn and takes it as far as the approval. */
  resume: async (opts) => {
    const { harness, mail } = buildExecutor(opts);
    await harness.start();
    await harness.wake();
    const held = await heldOn(harness, 'mail:msg-1042');
    // The provider never heard back from the executor that was killed, so it sends
    // the email again. This is a new process: only storage knows it was seen.
    const email = EMAILS.first;
    assert(email);
    await mail.emit({
      type: 'received',
      ...email,
    });
    await harness.waitForIdle();
    say({
      held,
      stillHeld: (
        await harness.pending({
          threadId: 'mail:msg-1042',
        })
      ).length,
    });
    await harness.close();
  },

  /** The reviewer's decision arrives a day later, as an item passed to `execute()` on whichever executor is up. */
  review: async (opts) => {
    const { harness } = buildExecutor(opts);
    const thread = {
      threadId: 'mail:msg-1042',
    };
    const held = await heldOn(harness, thread.threadId);

    // An approval for a different action than the one proposed is refused.
    let refusal = 'accepted';
    try {
      await harness.execute(
        {
          type: 'noetic:decision',
          callId: held.callId,
          argsHash: 'the-hash-of-some-other-payment',
          action: 'allow',
        },
        thread,
      );
    } catch (error) {
      refusal = isNoeticError(error) ? error.noeticError.kind : String(error);
    }
    // Refused means untouched: the call is still waiting for the right answer.
    const stillHeld = (await harness.pending(thread)).length;

    await harness.execute(
      {
        type: 'noetic:decision',
        callId: held.callId,
        argsHash: held.argsHash,
        action: 'allow',
      },
      thread,
    );
    await harness.wake(thread);
    const response = await paidOn(harness, thread.threadId);
    say({
      refusal,
      stillHeld,
      text: response.text,
      parked: response.parked !== undefined,
    });
    await harness.close();
  },

  /** The rule changed. A new email is handled by the new version. */
  'new-rule': async (opts) => {
    const { harness, mail } = buildExecutor(opts);
    await harness.start();
    const email = EMAILS.second;
    assert(email);
    await mail.emit({
      type: 'received',
      ...email,
    });
    const thread = {
      threadId: 'mail:msg-2077',
    };
    const held = await heldOn(harness, thread.threadId);
    await harness.execute(
      {
        type: 'noetic:decision',
        callId: held.callId,
        argsHash: held.argsHash,
        action: 'allow',
      },
      thread,
    );
    await harness.wake(thread);
    const response = await paidOn(harness, thread.threadId);
    // Long after it was handled, the first email turns up once more.
    const old = EMAILS.first;
    assert(old);
    await mail.emit({
      type: 'received',
      ...old,
    });
    await harness.waitForIdle();
    say({
      proposed: held.args,
      text: response.text,
      trail: {
        first: summary(
          await harness.getAuditTrail({
            threadId: 'mail:msg-1042',
          }),
        ),
        second: summary(await harness.getAuditTrail(thread)),
      },
    });
    await harness.close();
  },
};

const ExecutorArgsSchema = z.object({
  role: z.string(),
  name: z.string(),
  version: z.string(),
  file: z.string(),
  clockOffsetMs: z.number(),
});

async function runExecutor(encoded: string): Promise<void> {
  const args = ExecutorArgsSchema.parse(JSON.parse(encoded));
  const role = roles[args.role];
  assert(role, `unknown role ${args.role}`);
  const db = new Database(args.file);
  db.exec('PRAGMA busy_timeout = 5000');
  await role({
    name: args.name,
    version: args.version,
    db,
    clockOffsetMs: args.clockOffsetMs,
    hangInLookup: false,
  });
  db.close();
  process.exit(0);
}

//#endregion

//#region The script

interface Started {
  /** Resolves each report the executor prints, in order. */
  next(): Promise<Record<string, unknown>>;
  kill(): Promise<void>;
  exited: Promise<number>;
}

function startExecutor(args: z.infer<typeof ExecutorArgsSchema>): Started {
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      '--executor',
      JSON.stringify(args),
    ],
    {
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
  const reports: Array<Record<string, unknown>> = [];
  const waiting: Array<(report: Record<string, unknown>) => void> = [];
  const ReportSchema = z.record(z.string(), z.unknown());

  const read = async (): Promise<void> => {
    let buffered = '';
    for await (const chunk of child.stdout) {
      buffered += new TextDecoder().decode(chunk);
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('@@')) {
          continue;
        }
        const report = ReportSchema.parse(JSON.parse(line.slice(2)));
        const waiter = waiting.shift();
        if (waiter) {
          waiter(report);
          continue;
        }
        reports.push(report);
      }
    }
  };
  void read();

  return {
    exited: child.exited,
    next: () => {
      const ready = reports.shift();
      if (ready) {
        return Promise.resolve(ready);
      }
      return Promise.race([
        new Promise<Record<string, unknown>>((resolve) => {
          waiting.push(resolve);
        }),
        child.exited.then((code) => {
          throw new Error(`executor "${args.name}" exited (${code}) before it reported`);
        }),
      ]);
    },
    kill: async () => {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) {
    failed += 1;
  }
  console.log(
    `  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
  );
}

function count(db: Database, sql: string): number {
  return z
    .object({
      n: z.number(),
    })
    .parse(db.prepare(sql).get()).n;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'noetic-vendor-email-'));
  const file = path.join(dir, 'desk.db');
  const db = new Database(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  outsideWorld(db);
  const executor = (
    role: string,
    name: string,
    more: {
      version?: string;
      day?: number;
    } = {},
  ) =>
    startExecutor({
      role,
      name,
      version: more.version ?? 'v1',
      file,
      clockOffsetMs: (more.day ?? 0) * DAY_MS,
    });

  try {
    console.log('\n1. A vendor email arrives twice; the executor is killed mid-run');
    const first = executor('receive', 'executor-a');
    await first.next();
    await first.kill();
    check('one case was opened', count(db, 'SELECT COUNT(*) AS n FROM cases') === 1);
    check(
      'the tracker was asked once',
      count(db, "SELECT COUNT(*) AS n FROM attempts WHERE system = 'cases'") === 1,
    );
    check('nothing was paid', count(db, 'SELECT COUNT(*) AS n FROM payments') === 0);

    console.log('\n2. Another executor picks the turn up and stops at the approval');
    const second = executor('resume', 'executor-b');
    const { held, stillHeld } = z
      .object({
        held: z.object({
          name: z.string(),
          reason: z.string(),
          args: PaymentSchema,
        }),
        stillHeld: z.number(),
      })
      .parse(await second.next());
    await second.exited;
    check(
      'the payment is held for a person',
      held.name === 'pay_vendor' && held.reason === 'approval',
    );
    check('it proposes the v1 rule: pay in full', held.args.amount === 1200, held.args);
    check(
      'the email sent again to the new executor opened no second case',
      stillHeld === 1 &&
        count(db, 'SELECT COUNT(*) AS n FROM cases') === 1 &&
        count(db, "SELECT COUNT(*) AS n FROM attempts WHERE system = 'cases'") === 1,
    );
    check(
      'the bank was not asked, and nothing was paid, while it waits',
      count(db, "SELECT COUNT(*) AS n FROM attempts WHERE system = 'bank'") === 0 &&
        count(db, 'SELECT COUNT(*) AS n FROM payments') === 0,
    );

    console.log('\n3. The next day a reviewer approves the exact action');
    const third = executor('review', 'executor-c', {
      day: 1,
    });
    const reviewed = z
      .object({
        refusal: z.string(),
        stillHeld: z.number(),
        text: z.string(),
        parked: z.boolean(),
      })
      .parse(await third.next());
    await third.exited;
    check(
      "an approval that carries another action's hash is refused, and the call stays held",
      reviewed.refusal === 'hold_refused' && reviewed.stillHeld === 1,
      reviewed,
    );
    check('the turn finished on the third executor', !reviewed.parked, reviewed.text);
    check(
      'the bank was asked once',
      count(db, "SELECT COUNT(*) AS n FROM attempts WHERE system = 'bank'") === 1,
    );
    check('one payment exists', count(db, 'SELECT COUNT(*) AS n FROM payments') === 1);

    console.log('\n4. The owner changes the rule; the trail shows who handled what');
    const fourth = executor('new-rule', 'executor-d', {
      version: 'v2',
      day: 1,
    });
    const MarkSchema = z.object({
      step: z.string(),
      version: z.string().optional(),
      holder: z.string().optional(),
      receipt: z.unknown().optional(),
    });
    const after = z
      .object({
        proposed: PaymentSchema,
        text: z.string(),
        trail: z.object({
          first: z.array(MarkSchema),
          second: z.array(MarkSchema),
        }),
      })
      .parse(await fourth.next());
    await fourth.exited;
    check(
      'the new email got the v2 rule: 10% retained',
      after.proposed.amount === 720,
      after.proposed,
    );
    const firstPay = after.trail.first.find((mark) => mark.step === 'pay');
    const firstCase = after.trail.first.find((mark) => mark.step === 'open-case');
    const secondPay = after.trail.second.find((mark) => mark.step === 'pay');
    check(
      'case 1 was opened by the executor that was killed',
      firstCase?.holder === 'executor-a',
      firstCase,
    );
    check(
      'case 1 was paid under v1, by the third executor, with a receipt',
      firstPay?.version === 'v1' &&
        firstPay.holder === 'executor-c' &&
        firstPay.receipt !== undefined,
      firstPay,
    );
    check(
      'case 2 was paid under v2, with a receipt',
      secondPay?.version === 'v2' && secondPay.receipt !== undefined,
      secondPay,
    );
    const made = (system: string): number =>
      count(db, `SELECT COUNT(*) AS n FROM attempts WHERE system = '${system}'`);
    check(
      'two cases and two payments, each system asked once per email, the old email included',
      count(db, 'SELECT COUNT(*) AS n FROM cases') === 2 &&
        count(db, 'SELECT COUNT(*) AS n FROM payments') === 2 &&
        made('cases') === 2 &&
        made('bank') === 2,
      {
        cases: made('cases'),
        bank: made('bank'),
      },
    );
  } finally {
    db.close();
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  }

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

//#endregion

const executorArgs = process.argv.indexOf('--executor');
if (executorArgs >= 0) {
  await runExecutor(process.argv[executorArgs + 1] ?? '');
} else {
  await main();
}
