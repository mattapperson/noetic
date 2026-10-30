/**
 * The mutable state one verification run accumulates between its phases:
 * observations, gaps, anomalies and violations.
 */

import type {
  Anomaly,
  BlindSpot,
  BlindSpotKind,
  ChannelDescriptor,
  ConstraintViolation,
  Observation,
  PreparedVerify,
  SubjectRef,
  VerifyConnection,
  VerifyHost,
} from '@noetic-tools/types/verify';
import { channelDescriptor } from './descriptors';
import type { Recorded } from './observations';
import type { EvaluationContext } from './predicates';
import { evaluatePredicate } from './predicates';

//#region Types

/** One participant as the run uses it. */
export interface RunParticipant {
  readonly name: string;
  readonly role: 'subject' | 'witness';
  readonly connection: VerifyConnection;
  /** The subject ref when the run started. */
  readonly subject: SubjectRef;
  /** Senses this participant must watch for the verify. */
  readonly senses: ReadonlyArray<string>;
}

//#endregion

//#region Public API

/** What a run has gathered so far. */
export class RunState implements EvaluationContext {
  readonly prepared: PreparedVerify;
  readonly host: VerifyHost;
  readonly participants: ReadonlyArray<RunParticipant>;
  /** Observations inside the window. */
  readonly recorded: Recorded[] = [];
  /** Observations from the check before the action. */
  readonly before: Recorded[] = [];
  readonly blindSpots: BlindSpot[] = [];
  readonly anomalies: Anomaly[] = [];
  readonly violations: ConstraintViolation[] = [];
  /** Participant → senses it listened to. */
  readonly listened = new Map<string, Set<string>>();
  /** Senses something actually observed (for `Coverage.observed`). */
  readonly observed = new Set<string>();
  /**
   * Participant → the cursor its first confirmed listener started from: coverage
   * and anomalies are asked for since then, so earlier ones never judge this window.
   */
  readonly startCursors = new Map<string, string>();
  /** Set when the window closes; listeners drop anything after it. */
  closed = false;
  /** Last time anything arrived, for quiet detection. */
  lastActivity: number;
  private readonly eventTypes = new Map<string, string>();
  private readonly violated = new Set<string>();
  private readonly spotKeys = new Set<string>();
  private nextId = 0;

  constructor(opts: {
    prepared: PreparedVerify;
    host: VerifyHost;
    participants: ReadonlyArray<RunParticipant>;
  }) {
    this.prepared = opts.prepared;
    this.host = opts.host;
    this.participants = opts.participants;
    this.lastActivity = opts.host.now();
  }

  get subject(): RunParticipant {
    const subject = this.participants.find((p) => p.role === 'subject');
    if (!subject) {
      throw new Error('verify run has no subject');
    }
    return subject;
  }

  /** A fresh, run-unique observation id. */
  id(prefix: string): string {
    this.nextId += 1;
    return `${prefix}/${this.nextId}`;
  }

  now(): number {
    return Math.round(this.host.now());
  }

  eventTypeOf(observation: Observation): string | undefined {
    return this.eventTypes.get(observation.id);
  }

  /** Records an observation inside the window and checks every `never` against it. */
  record(entry: Recorded): void {
    this.recorded.push(entry);
    this.observed.add(entry.observation.channel);
    if (entry.eventType !== undefined) {
      this.eventTypes.set(entry.observation.id, entry.eventType);
    }
    this.lastActivity = this.host.now();
    this.checkNever(entry.observation);
  }

  /** Records an observation from the check before the action. */
  recordBefore(entry: Recorded): void {
    this.before.push(entry);
  }

  /** Adds a gap once per kind, sense and detail. */
  gap(
    kind: BlindSpotKind,
    detail: string,
    opts?: {
      channel?: string;
      impeaching?: boolean;
      remedy?: string;
    },
  ): void {
    const key = `${kind}|${opts?.channel ?? ''}|${detail}`;
    if (this.spotKeys.has(key)) {
      return;
    }
    this.spotKeys.add(key);
    this.blindSpots.push({
      kind,
      detail,
      impeaching: opts?.impeaching ?? true,
      ...(opts?.channel === undefined
        ? {}
        : {
            channel: opts.channel,
          }),
      ...(opts?.remedy === undefined
        ? {}
        : {
            remedy: opts.remedy,
          }),
    });
  }

  /** The descriptor of a sense, from the participant that declares it (the subject first). */
  descriptor(sense: string): ChannelDescriptor | undefined {
    const owner = this.participants.find((p) => p.connection.manifest.senses[sense] !== undefined);
    if (!owner) {
      return undefined;
    }
    return channelDescriptor(sense, owner.connection.manifest.senses[sense]);
  }

  /** Checks every constraint not yet broken; the first that breaks records a violation at that moment. */
  checkNever(trigger: Observation): void {
    for (const constraint of this.prepared.constraints) {
      if (this.violated.has(constraint.id) || !constraint.channels.includes(trigger.channel)) {
        continue;
      }
      const observations = this.recorded
        .map((r) => r.observation)
        .filter((o) => constraint.channels.includes(o.channel));
      if (evaluatePredicate(constraint.predicate, observations, this) !== false) {
        continue;
      }
      this.violated.add(constraint.id);
      this.violations.push({
        constraint: constraint.id,
        at: trigger.at,
        detail: `${constraint.statement}: broken by ${trigger.channel} ${trigger.summary}`,
        evidence: [
          trigger.id,
        ],
      });
    }
  }
}

//#endregion
