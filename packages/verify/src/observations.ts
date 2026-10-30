/**
 * Turning what a connection reports — events and reads — into OVP
 * observations and evidence. Senses are OVP channel ids already (spec 36 §
 * Senses), so the translation at this boundary is one of shape, not of names.
 */

import type { ConnectionEvent, ConnectionIdentity } from '@noetic-tools/types';
import { REDACTED_TEXT } from '@noetic-tools/types';
import type {
  ChannelDescriptor,
  Evidence,
  Observation,
  SubjectRef,
} from '@noetic-tools/types/verify';
import { render } from 'open-verification';
import { z } from 'zod';

//#region Types

/** One observation with where it came from. */
export interface Recorded {
  readonly observation: Observation;
  /** The participant that reported it. */
  readonly participant: string;
  /** The event type behind it, for event matchers. */
  readonly eventType?: string;
  /** How it was obtained: `listen`, `read` or `act`. */
  readonly method: 'listen' | 'read' | 'act';
  /** The subject as it was when observed. */
  readonly subject: SubjectRef;
}

//#endregion

//#region Schemas

/** A payload or read value that carries its own summary, as spec 36 asks servers to produce. */
const SummarizedSchema = z
  .object({
    summary: z.string(),
  })
  .loose();

//#endregion

//#region Helpers

function summarized(value: unknown):
  | {
      summary: string;
      value: unknown;
    }
  | undefined {
  const parsed = SummarizedSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const record = parsed.data;
  return {
    summary: record.summary,
    value: 'value' in record ? record.value : record,
  };
}

/** Summaries a read value holds: the value itself, a list of them, or lists inside an object. */
function readEntries(
  value: unknown,
  resource: string,
): Array<{
  summary: string;
  value: unknown;
}> {
  if (Array.isArray(value)) {
    return value.flatMap((v) => readEntries(v, resource));
  }
  const own = summarized(value);
  if (own) {
    return [
      own,
    ];
  }
  const nested = nestedLists(value).flatMap((list) =>
    list.map(summarized).filter((e): e is NonNullable<typeof e> => e !== undefined),
  );
  if (nested.length > 0) {
    return nested;
  }
  return [
    {
      summary: resource,
      value,
    },
  ];
}

function nestedLists(value: unknown): unknown[][] {
  const record = z.record(z.string(), z.unknown()).safeParse(value);
  if (!record.success) {
    return [];
  }
  return Object.values(record.data).filter((v): v is unknown[] => Array.isArray(v));
}

function eventTime(event: ConnectionEvent, fallback: number): number {
  const parsed = Date.parse(event.time);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

//#endregion

//#region Public API

/** The OVP subject a connection identity names. */
export function subjectRefOf(identity: ConnectionIdentity): SubjectRef {
  return {
    surface: identity.surface,
    instance: identity.instance,
    ...(identity.epoch === undefined
      ? {}
      : {
          epoch: identity.epoch,
        }),
  };
}

/** An event as one observation on `channel`. */
export function observeEvent(opts: {
  event: ConnectionEvent;
  channel: string;
  window: string;
  id: string;
  now: number;
}): Observation {
  const { event, channel, window, id, now } = opts;
  const own = summarized(event.payload);
  return {
    id,
    window,
    channel,
    at: eventTime(event, now),
    value: own ? own.value : event.payload,
    summary: own ? own.summary : event.type,
  };
}

/** A read's value as observations on `channel`. */
export function observeRead(opts: {
  value: unknown;
  resource: string;
  channel: string;
  window: string;
  idPrefix: string;
  now: number;
}): Observation[] {
  const { value, resource, channel, window, idPrefix, now } = opts;
  return readEntries(value, resource).map((entry, i) => ({
    id: `${idPrefix}#${i}`,
    window,
    channel,
    at: now,
    value: entry.value,
    summary: entry.summary,
  }));
}

/** Whether a value carries a withheld secret or sensitive field. */
export function isRedacted(value: unknown): boolean {
  return render(value).includes(REDACTED_TEXT);
}

/** Recorded observations as OVP evidence, with each sense's declared independence and grade. */
export function toEvidence(
  recorded: ReadonlyArray<Recorded>,
  descriptors: ReadonlyMap<string, ChannelDescriptor>,
): Evidence[] {
  return recorded.flatMap((r) => {
    const descriptor = descriptors.get(r.observation.channel);
    if (!descriptor) {
      return [];
    }
    return [
      {
        observation: r.observation,
        provenance: {
          class: 'observed',
          source: r.participant,
          method: r.method,
          subject: r.subject,
          at: r.observation.at,
        },
        independence: descriptor.independence,
        grade: descriptor.grade,
      },
    ];
  });
}

//#endregion
