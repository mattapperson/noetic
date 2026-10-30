/**
 * One verification run, in the order that makes its answer honest (spec 37 §
 * How it runs): declare, check before, listen, act, close, judge, record.
 */

import type {
  Action,
  ActionReceipt,
  Anomaly,
  Claim,
  CloseCondition,
  Evidence,
  Intent,
  PreparedVerify,
  RunWitness,
  VerificationRun,
  VerifyActResult,
  VerifyHost,
  VerifyOutput,
  Window,
} from '@noetic-tools/types/verify';
import { OVP_VERSION } from '@noetic-tools/types/verify';
import { invalidationBetween, outcomeOf } from 'open-verification';
import { channelDescriptors } from './descriptors';
import type { Judged } from './judge';
import { heldBefore, judgeClaim } from './judge';
import type { Listener } from './listen';
import { EXIT_SENSES, startListening, stopListening, WINDOW_ID } from './listen';
import { subjectRefOf, toEvidence } from './observations';
import { checkBefore, readAfter } from './reads';
import type { RunParticipant } from './run-state';
import { RunState } from './run-state';
import type { CloseTrigger, WindowPlan } from './window';
import { closeTrigger, planWindow, waitForClose } from './window';

//#region Types

/** Who is running the verify, for the run document. */
export interface VerifierInfo {
  readonly name: string;
  readonly version: string;
}

interface Timeline {
  readonly startedAt: number;
  readonly before: Window;
  readonly window: Window;
  readonly action: Action;
  readonly receipt: ActionReceipt;
  readonly actEvidence: Evidence[];
}

//#endregion

//#region Constants

/** The sense an `act` failure is recorded on; no claim reads it. */
const ACT_CHANNEL = 'x-noetic-act';

//#endregion

//#region Helpers

function participantsOf(prepared: PreparedVerify, host: VerifyHost): RunParticipant[] {
  const witnesses = Object.values(host.witnesses).map(
    (connection): RunParticipant => ({
      name: connection.name,
      role: 'witness',
      connection,
      subject: subjectRefOf(connection.identity()),
      senses: prepared.senses[connection.name] ?? [],
    }),
  );
  return [
    {
      name: host.subject.name,
      role: 'subject',
      connection: host.subject,
      subject: subjectRefOf(host.subject.identity()),
      senses: prepared.senses[host.subject.name] ?? [],
    },
    ...witnesses,
  ];
}

/**
 * Declare: claims lowered from `expect` are declared before the action
 * (OVP-INTENT-3); a full-form OVP claim keeps the `declaredAt` it was given, so
 * one marked written after the fact is judged as such (OVP clause 8).
 */
function declare(
  prepared: PreparedVerify,
  at: number,
): {
  claims: Claim[];
  intents: Intent[];
} {
  const claims = prepared.claims.map((c) => ({
    ...c,
  }));
  const statement = prepared.spec.intent;
  const intents: Intent[] =
    statement === undefined
      ? []
      : [
          {
            id: `${prepared.spec.id}.intent`,
            statement,
            origin: 'workflow',
            claims: claims.map((c) => c.id),
            declaredAt: at,
            status: 'bound',
          },
        ];
  return {
    claims,
    intents,
  };
}

/**
 * Events on the subject that can end the window: termination from outside
 * always (whatever `until` is — a terminated window is never clean), and the
 * process exiting for an `until: 'exit'` window.
 */
function exitEvents(state: RunState, plan: WindowPlan): string[] {
  return Object.values(state.subject.connection.manifest.events)
    .filter((e) => e.sense !== undefined && endsWindow(e.sense, plan))
    .map((e) => e.name);
}

function endsWindow(sense: string, plan: WindowPlan): boolean {
  const exit = EXIT_SENSES[sense];
  return exit === 'terminated' || (exit === 'exit' && plan.until === 'exit');
}

/** Whether the subject was replaced since the run began (a new identity instance). */
function subjectReplaced(state: RunState): boolean {
  const change = invalidationBetween(
    state.subject.subject,
    subjectRefOf(state.subject.connection.identity()),
  );
  return change?.kind === 'instance';
}

function onEventFor(
  state: RunState,
  plan: WindowPlan,
  trigger: CloseTrigger,
): (
  l: Listener,
  e: {
    type: string;
  },
) => void {
  return (listener, event) => {
    // A subject replaced mid-window ends the window at once (spec 37 § Windows).
    if (subjectReplaced(state)) {
      trigger.fire('terminated');
      return;
    }
    if (listener.participant.role !== 'subject') {
      return;
    }
    if (plan.event !== undefined && event.type === plan.event) {
      trigger.fire('signal');
      return;
    }
    const exit = EXIT_SENSES[listener.channel];
    if (exit !== undefined && endsWindow(listener.channel, plan)) {
      trigger.fire(exit);
    }
  };
}

/** Gaps no listener or read could fill: senses never observed, `never`s on read-only senses. */
function unobservedGaps(state: RunState): void {
  for (const constraint of state.prepared.constraints) {
    for (const channel of constraint.channels) {
      const listened = [
        ...state.listened.values(),
      ].some((s) => s.has(channel));
      if (listened) {
        continue;
      }
      state.gap(
        'channel-unobserved',
        `never on ${channel} cannot be checked while the action runs: nothing listens to ${channel}`,
        {
          channel,
        },
      );
    }
  }
}

/** Gaps from what `act` left behind: long operations still running, effects on unwatched connections. */
function actGaps(state: RunState, act: VerifyActResult): void {
  for (const task of act.pendingTasks) {
    state.gap(
      'still-in-flight',
      `${task.connection} ${task.op} (task ${task.taskId}) was still running at close`,
      {
        impeaching: true,
      },
    );
  }
  const watched = new Set(state.participants.map((p) => p.name));
  for (const name of act.touched) {
    if (watched.has(name)) {
      continue;
    }
    state.gap('effect-elsewhere', `act changed ${name}, which this verify does not watch`, {
      impeaching: false,
    });
  }
}

/** Gaps and anomalies the servers report about themselves (`noetic://coverage`, `noetic.detect`). */
async function serverReports(state: RunState): Promise<void> {
  const signal = state.host.signal;
  for (const p of state.participants) {
    // Only this window's blind spots and anomalies: from where listening started.
    const since = state.startCursors.get(p.name) ?? null;
    const coverage = await p.connection
      .coverage?.(since, {
        signal,
      })
      .catch(() => []);
    for (const spot of coverage ?? []) {
      state.gap(spot.kind, spot.detail, {
        ...(spot.channel === undefined
          ? {}
          : {
              channel: spot.channel,
            }),
        impeaching: spot.impeaching,
        ...(spot.remedy === undefined
          ? {}
          : {
              remedy: spot.remedy,
            }),
      });
    }
    const anomalies = await p.connection
      .detect?.(since, {
        signal,
      })
      .catch(() => []);
    state.anomalies.push(...(anomalies ?? []));
  }
}

/**
 * A subject replaced mid-window ends the window (`terminated`): its evidence
 * belongs to a world that is gone. An edit (a new epoch) keeps the evidence and
 * says it predates the edit.
 */
function identityCheck(state: RunState, claims: ReadonlyArray<Claim>): CloseCondition | undefined {
  const started = state.subject.subject;
  const now = subjectRefOf(state.subject.connection.identity());
  const change = invalidationBetween(started, now);
  if (!change) {
    return undefined;
  }
  const replaced = change.kind === 'instance';
  const kind = replaced ? 'evidence-superseded' : 'evidence-predates-edit';
  const counter = replaced
    ? `the subject was replaced (${change.from} → ${change.to}); its evidence belongs to a world that is gone`
    : `the subject was edited (epoch ${change.from} → ${change.to}) after some of its evidence was gathered`;
  for (const claim of claims) {
    const [channel] = claim.assertions.flatMap((a) => a.channels);
    if (channel === undefined) {
      continue;
    }
    const anomaly: Anomaly = {
      kind,
      tier: 'advisory',
      claim: claim.statement,
      counter,
      between: [
        channel,
        channel,
      ],
      evidence: [],
    };
    state.anomalies.push(anomaly);
  }
  if (!replaced) {
    return undefined;
  }
  state.gap('channel-unobserved', counter, {
    impeaching: true,
  });
  return 'terminated';
}

function actRecords(opts: { state: RunState; act: VerifyActResult; at: number; window: string }): {
  action: Action;
  receipt: ActionReceipt;
  evidence: Evidence[];
} {
  const { state, act, at, window } = opts;
  const spec = state.prepared.spec;
  const action: Action = {
    id: `${spec.id}.act`,
    actor: spec.id,
    capability: 'act',
    at,
  };
  const receipt: ActionReceipt = {
    action: action.id,
    dispatched: act.error === undefined,
    subject: state.subject.subject,
    at: state.now(),
  };
  if (!act.error) {
    return {
      action,
      receipt,
      evidence: [],
    };
  }
  const evidence: Evidence = {
    observation: {
      id: state.id('act'),
      window,
      channel: ACT_CHANNEL,
      at: receipt.at,
      value: act.error.message,
      summary: `act failed: ${act.error.message}`,
    },
    provenance: {
      class: 'observed',
      source: 'harness',
      method: 'act',
      subject: state.subject.subject,
      at: receipt.at,
    },
    independence: 'independent',
    grade: 'context',
  };
  return {
    action,
    receipt,
    evidence: [
      evidence,
    ],
  };
}

function buildRun(opts: {
  state: RunState;
  verifier: VerifierInfo;
  claims: Claim[];
  intents: Intent[];
  timeline: Timeline;
  judged: ReadonlyArray<Judged>;
}): VerificationRun {
  const { state, verifier, claims, intents, timeline, judged } = opts;
  const descriptors = new Map(
    state.participants.flatMap((p) =>
      channelDescriptors(p.connection.manifest.senses).map(
        (d) =>
          [
            d.id,
            d,
          ] as const,
      ),
    ),
  );
  const witnesses: RunWitness[] = state.participants
    .filter((p) => p.role === 'witness')
    .map((p) => ({
      name: p.name,
      subject: p.subject,
      channels: channelDescriptors(p.connection.manifest.senses),
    }));
  return {
    ovp: OVP_VERSION,
    id: `${state.prepared.spec.id}:${crypto.randomUUID()}`,
    verifier: {
      name: verifier.name,
      version: verifier.version,
    },
    subject: state.subject.subject,
    channels: channelDescriptors(state.subject.connection.manifest.senses),
    witnesses,
    intents,
    claims,
    constraints: [
      ...state.prepared.constraints,
    ],
    actions: [
      timeline.action,
    ],
    receipts: [
      timeline.receipt,
    ],
    windows: [
      timeline.before,
      timeline.window,
    ],
    evidence: [
      ...toEvidence(state.before, descriptors),
      ...toEvidence(state.recorded, descriptors),
      ...timeline.actEvidence,
    ],
    coverage: [
      {
        window: timeline.window.id,
        observed: [
          ...state.observed,
        ],
        blindSpots: [
          ...state.blindSpots,
        ],
      },
    ],
    anomalies: [
      ...state.anomalies,
      ...judged.flatMap((j) => j.record.anomalies.filter((a) => !state.anomalies.includes(a))),
    ],
    verdicts: judged.map((j) => j.record),
    violations: [
      ...state.violations,
    ],
    repairs: judged.flatMap((j) =>
      j.repair
        ? [
            j.repair,
          ]
        : [],
    ),
    startedAt: timeline.startedAt,
    endedAt: state.now(),
  };
}

//#endregion

//#region Public API

/**
 * Runs a prepared verify against its host: declare, check before, listen,
 * act, close, judge, record. Never throws for a `no` or an `unknown`.
 */
export async function runVerify(opts: {
  prepared: PreparedVerify;
  host: VerifyHost;
  verifier: VerifierInfo;
}): Promise<VerifyOutput> {
  const { prepared, host, verifier } = opts;
  const state = new RunState({
    prepared,
    host,
    participants: participantsOf(prepared, host),
  });
  const plan = planWindow(prepared.spec.close);
  const startedAt = state.now();

  // 1. Declare.
  const { claims, intents } = declare(prepared, startedAt);

  // 2. Check before.
  const readable = await checkBefore(state);
  const beforeHeld = claims.map((c) => heldBefore(state, c, readable));
  const before: Window = {
    id: 'before',
    openedAt: startedAt,
    closedAt: state.now(),
    budgetMs: 1,
    closes: 'ack',
    closedBy: 'ack',
    subject: state.subject.subject,
  };

  // 3. Listen.
  const trigger = closeTrigger();
  const listenController = new AbortController();
  const stopOnHost = (): void => listenController.abort();
  host.signal.addEventListener('abort', stopOnHost, {
    once: true,
  });
  const listeners = await startListening({
    state,
    signal: listenController.signal,
    onEvent: onEventFor(state, plan, trigger),
    subjectExtra: exitEvents(state, plan),
  });
  unobservedGaps(state);
  const openedAt = state.now();

  // 4. Act.
  const act = await host.act();
  const actAt = state.now();
  state.lastActivity = host.now();

  // 5. Close.
  let closedBy = await waitForClose({
    state,
    plan,
    act,
    trigger,
  });
  state.closed = true;
  await stopListening(listeners);
  listenController.abort();
  host.signal.removeEventListener('abort', stopOnHost);
  await readAfter(state, Math.max(1, Math.min(plan.quietMs, 100)));
  actGaps(state, act);
  await serverReports(state);
  closedBy = identityCheck(state, claims) ?? closedBy;
  const window: Window = {
    id: WINDOW_ID,
    openedAt,
    closedAt: state.now(),
    budgetMs: Math.max(1, Math.round(plan.timeoutMs)),
    closes: plan.closes,
    closedBy,
    subject: state.subject.subject,
  };

  // 6. Judge.
  const judged = claims.map((claim, index) =>
    judgeClaim({
      state,
      claim,
      index,
      window,
      heldBefore: beforeHeld[index],
    }),
  );

  // 7. Record.
  const records = actRecords({
    state,
    act,
    at: actAt,
    window: WINDOW_ID,
  });
  const run = buildRun({
    state,
    verifier,
    claims,
    intents,
    timeline: {
      startedAt,
      before,
      window,
      action: records.action,
      receipt: records.receipt,
      actEvidence: records.evidence,
    },
    judged,
  });
  const ref = await host.record(run);
  return {
    outcome: outcomeOf(run),
    verdicts: judged.map((j) => j.verdict),
    violations: run.violations,
    gaps: run.coverage.flatMap((c) => c.blindSpots),
    repairs: run.repairs,
    run: ref,
  };
}

//#endregion
