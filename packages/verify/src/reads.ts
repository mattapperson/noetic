/**
 * Reads: the check before the action (spec 37 § How it runs, step 2) and the
 * reads after the window closes for senses nothing could listen to. A witness
 * closes by its own condition — two reads in a row that agree — so replication
 * lag is not mistaken for a missing write (spec 37 § Witnesses).
 */

import { render } from 'open-verification';
import type { Recorded } from './observations';
import { observeRead } from './observations';
import type { RunParticipant, RunState } from './run-state';

//#region Constants

/** Most reads a witness gets to agree with itself. */
const WITNESS_MAX_READS = 5;

/** The resource a server lists its blind spots at; never read as evidence. */
const COVERAGE_RESOURCE_PREFIX = 'noetic://coverage';

//#endregion

//#region Helpers

/** Resources on a participant that report a sense. */
export function resourcesFor(p: RunParticipant, sense: string): string[] {
  return Object.values(p.connection.manifest.resources)
    .filter((r) => r.sense === sense && !r.name.startsWith(COVERAGE_RESOURCE_PREFIX))
    .map((r) => r.name);
}

async function readOnce(opts: {
  state: RunState;
  participant: RunParticipant;
  resource: string;
  sense: string;
  window: string;
}): Promise<Recorded[]> {
  const { state, participant, resource, sense, window } = opts;
  const value = await participant.connection.read(resource, {
    signal: state.host.signal,
  });
  return observeRead({
    value,
    resource,
    channel: sense,
    window,
    idPrefix: state.id(`${participant.name}:${resource}`),
    now: state.now(),
  }).map((observation) => ({
    observation,
    participant: participant.name,
    method: 'read',
    subject: participant.subject,
  }));
}

function sameReading(a: ReadonlyArray<Recorded>, b: ReadonlyArray<Recorded>): boolean {
  const shape = (list: ReadonlyArray<Recorded>): string =>
    render(
      list.map((r) => [
        r.observation.summary,
        r.observation.value,
      ]),
    );
  return shape(a) === shape(b);
}

/** Reads until two reads in a row agree, or gives up with the last one. */
async function readUntilAgree(opts: {
  state: RunState;
  participant: RunParticipant;
  resource: string;
  sense: string;
  window: string;
  delayMs: number;
}): Promise<{
  readings: Recorded[];
  agreed: boolean;
}> {
  let previous = await readOnce(opts);
  for (let i = 1; i < WITNESS_MAX_READS; i++) {
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    const next = await readOnce(opts);
    if (sameReading(previous, next)) {
      return {
        readings: next,
        agreed: true,
      };
    }
    previous = next;
  }
  return {
    readings: previous,
    agreed: false,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

//#endregion

//#region Public API

/**
 * Reads every sense the verify needs, as the subject and witnesses are now.
 * @returns The senses that could be read on every participant that watches them.
 */
export async function checkBefore(state: RunState): Promise<Set<string>> {
  const readable = new Set<string>();
  const unreadable = new Set<string>();
  for (const p of state.participants) {
    for (const sense of p.senses) {
      const resources = resourcesFor(p, sense);
      if (resources.length === 0) {
        unreadable.add(sense);
        continue;
      }
      try {
        for (const resource of resources) {
          const readings = await readOnce({
            state,
            participant: p,
            resource,
            sense,
            window: 'before',
          });
          for (const r of readings) {
            state.recordBefore(r);
          }
        }
        readable.add(sense);
      } catch {
        unreadable.add(sense);
      }
    }
  }
  for (const sense of unreadable) {
    readable.delete(sense);
  }
  return readable;
}

/**
 * After the window closes, reads each sense a participant watches but could
 * not listen to. A witness reads until two reads agree; one that never agrees
 * adds a `still-in-flight` gap, and one that could not look adds a
 * `channel-unobserved` gap — never evidence that nothing happened.
 */
export async function readAfter(state: RunState, delayMs: number): Promise<void> {
  for (const p of state.participants) {
    const listened = state.listened.get(p.name) ?? new Set<string>();
    for (const sense of p.senses) {
      if (listened.has(sense)) {
        continue;
      }
      await readSense({
        state,
        participant: p,
        sense,
        delayMs,
      });
    }
  }
}

async function readSense(opts: {
  state: RunState;
  participant: RunParticipant;
  sense: string;
  delayMs: number;
}): Promise<void> {
  const { state, participant, sense, delayMs } = opts;
  const resources = resourcesFor(participant, sense);
  if (resources.length === 0) {
    state.gap(
      'channel-unobserved',
      `${participant.name} declares ${sense} but nothing on it reports ${sense}`,
      {
        channel: sense,
      },
    );
    return;
  }
  for (const resource of resources) {
    try {
      const { readings, agreed } =
        participant.role === 'witness'
          ? await readUntilAgree({
              state,
              participant,
              resource,
              sense,
              window: 'window',
              delayMs,
            })
          : {
              readings: await readOnce({
                state,
                participant,
                resource,
                sense,
                window: 'window',
              }),
              agreed: true,
            };
      for (const r of readings) {
        state.record(r);
      }
      if (!agreed) {
        state.gap('still-in-flight', `witness ${participant.name}'s ${resource} kept changing`, {
          channel: sense,
        });
      }
    } catch (error) {
      state.gap(
        'channel-unobserved',
        `${participant.name} could not read ${resource}: ${describeError(error)}`,
        {
          channel: sense,
        },
      );
    }
  }
}

//#endregion
