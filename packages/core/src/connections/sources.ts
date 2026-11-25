/**
 * Sources (spec 35 § Triggers): event streams written in code — a queue
 * consumer, a file watcher, a webhook from your own app — registered as
 * connections. `defineSource({ events, start })` validates each emitted
 * payload against its event's schema; `start` runs once a listener subscribes
 * and receives the last durable cursor a trigger recorded. Host code can also
 * push with `source.emit(…)`; events pushed before anyone listens are held
 * (up to `WAIT_BUFFER_LIMIT`) for the first listener.
 *
 * `cron(schedule, { timezone })` is a built-in source with one event, `tick`,
 * delivered once per scheduled time even after downtime: a restarted trigger
 * resumes from its cursor and receives every tick it missed.
 */

import type {
  Connection,
  ConnectionEventInfo,
  ConnectionEventInit,
  ConnectionManifest,
  ConnectionSource,
  ConnectOptions,
  Cron,
  CronEvents,
  CronTick,
  DefineSource,
  EventStream,
  JsonSchemaObject,
  ListenRequest,
  SourceDefinition,
  SourceEmitEvent,
  SourceEventSchemas,
} from '@noetic-tools/types';
import { WAIT_BUFFER_LIMIT } from '@noetic-tools/types';
import { z } from 'zod';
import { nextCronRun, parseCronSchedule } from './cron-schedule';
import { invalidConnectionError } from './errors';
import type { Listener } from './in-memory-connection';
import { createListenerStream } from './in-memory-connection';

//#region Constants

/** The most missed ticks a restarted cron delivers at once. */
const CRON_CATCH_UP_LIMIT = 1e3;

const CronTickSchema: z.ZodType<CronTick> = z.object({
  scheduledFor: z.string(),
});

//#endregion

//#region Helpers

function jsonSchemaOf(schema: z.ZodType): JsonSchemaObject | undefined {
  try {
    return z.toJSONSchema(schema, {
      unrepresentable: 'any',
    });
  } catch {
    return undefined;
  }
}

function manifestOf(events: SourceEventSchemas, durable: boolean): ConnectionManifest {
  const infos: Record<string, ConnectionEventInfo> = {};
  for (const [name, schema] of Object.entries(events)) {
    const payloadSchema = jsonSchemaOf(schema);
    infos[name] = {
      name,
      replay: durable ? 'durable' : 'live',
      ...(payloadSchema
        ? {
            payloadSchema,
          }
        : {}),
    };
  }
  return {
    profiles: {},
    extensions: {},
    operations: {},
    resources: {},
    events: infos,
    senses: {},
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      },
      Math.max(0, ms),
    );
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      timer.unref();
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, {
      once: true,
    });
  });
}

//#endregion

//#region Source hub

/**
 * Give `event` to a listener that stores what it receives, and resolve once it says
 * the event is stored. Rejects with its error, or if the listener ends first.
 */
function handToStore(listener: Listener, event: ConnectionEventInit): Promise<void> {
  return new Promise((resolve, reject) => {
    const ended = (): void => {
      reject(new Error(`The listener for '${event.type}' ended before it stored the event.`));
    };
    listener.onEnd.add(ended);
    listener.push({
      type: 'event',
      event,
      stored: (error) => {
        listener.onEnd.delete(ended);
        if (error === undefined) {
          resolve();
          return;
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    });
  });
}

/**
 * The cursor of a source that has emitted nothing yet: "before the first event". A
 * listener that starts there and listens again later gets everything since.
 */
const SOURCE_ORIGIN = '';

/**
 * The prefix of a position a hub makes up for an event its source gave no cursor:
 * the event's place in what the hub emitted. It means nothing to the source, and
 * nothing to a hub in another process.
 */
const LOCAL_POSITION = 'noetic-local:';

function isLocalPosition(cursor: string | null): boolean {
  return cursor?.startsWith(LOCAL_POSITION) === true;
}

/** The live side of a source: its listeners, its pending events, and its one running `start`. */
class SourceHub<E extends SourceEventSchemas> {
  readonly listeners = new Set<Listener>();
  private readonly pending: ConnectionEventInit[] = [];
  /**
   * What a source with a `start` has emitted, newest last, so a listener that comes
   * with a cursor gets what came after it. Without this only the first listener ever
   * saw a replay, though the manifest says the events replay from a cursor.
   */
  private readonly history: ConnectionEventInit[] = [];
  /** How many events this hub has emitted: the place of the newest in `history`. */
  private emitted = 0;
  /** Tells this hub's own positions from those of a hub in an earlier process. */
  private readonly epoch = crypto.randomUUID();
  private started = false;
  private controller = new AbortController();
  /**
   * Event types a storing listener (a trigger) has asked for and not given up.
   * While one is away, between a failed write and its next listen, an event of that
   * type has nowhere durable to go.
   */
  private readonly storers = new Map<string, number>();

  constructor(private readonly definition: SourceDefinition<E>) {}

  /** Check `event` against its schema and stamp it. */
  private stamp(event: SourceEmitEvent): ConnectionEventInit {
    const schema = this.definition.events[event.type];
    if (!schema) {
      throw invalidConnectionError(
        `The source has no event '${event.type}'.`,
        `Emit one of: ${Object.keys(this.definition.events).join(', ')}.`,
      );
    }
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) {
      throw invalidConnectionError(
        `Payload of source event '${event.type}' does not match its schema: ${parsed.error.message}`,
        `Emit a payload the '${event.type}' schema accepts.`,
      );
    }
    return {
      id: event.id,
      type: event.type,
      time: event.time ?? new Date().toISOString(),
      payload: parsed.data,
      cursor: event.cursor ?? null,
    };
  }

  async emit(event: SourceEmitEvent): Promise<void> {
    const init = this.stamp(event);
    if (this.definition.start) {
      this.history.push(init);
      this.emitted += 1;
      if (this.history.length > WAIT_BUFFER_LIMIT) {
        this.history.shift();
      }
    }
    const targets = [
      ...this.listeners,
    ].filter((l) => l.event === event.type);
    // A trigger stores this event type but is not listening at this moment (it is
    // backing off after a failure). Holding the event in memory and saying it is
    // taken would be a lie the sender cannot check: say it was not stored.
    const storing = targets.some((l) => l.stores);
    if (!storing && (this.storers.get(event.type) ?? 0) > 0) {
      throw new Error(
        `Source event '${event.type}' was not stored: the trigger that stores it is not listening right now. Send it again.`,
      );
    }
    if (targets.length === 0) {
      this.pending.push(init);
      if (this.pending.length > WAIT_BUFFER_LIMIT) {
        this.pending.shift();
      }
      return;
    }
    const stored: Promise<void>[] = [];
    for (const listener of targets) {
      if (!listener.stores) {
        listener.push({
          type: 'event',
          event: init,
        });
        continue;
      }
      stored.push(handToStore(listener, init));
    }
    // Resolve only once every trigger has the event in its inbox.
    await Promise.all(stored);
  }

  listen(request: ListenRequest): EventStream {
    const asked = request.cursor ?? null;
    if (this.definition.schedule && this.definition.start) {
      return this.listenAlone(request, asked);
    }
    const { stream, listener } = createListenerStream(this.listeners, request, {
      // Where this listener starts: what it asked for, or where the source is now. A
      // wait records it, and listening again from it replays what came since.
      cursor: asked ?? this.position(),
    });
    if (request.signal.aborted) {
      return stream;
    }
    this.listeners.add(listener);
    if (listener.stores) {
      this.expectStore(request);
    }
    const held = this.pending.filter((e) => e.type === request.event);
    for (const event of held) {
      this.pending.splice(this.pending.indexOf(event), 1);
    }
    // A listener with a cursor gets everything after it; one without gets only
    // what nobody was there to hear.
    const replay = asked === null ? held : this.since(asked, request.event);
    for (const event of replay) {
      listener.push({
        type: 'event',
        event,
      });
    }
    // A position this hub made up is not a cursor the source knows.
    this.startOnce(asked === SOURCE_ORIGIN || isLocalPosition(asked) ? null : asked);
    return stream;
  }

  /**
   * Listen to a source with a schedule. Its events are a function of time, not a
   * stream to share, so each listener gets a run of `start` of its own, from its own
   * cursor: two triggers on one `cron()` each get every tick they missed, whichever
   * of them was behind.
   */
  private listenAlone(request: ListenRequest, asked: string | null): EventStream {
    const { schedule, start } = this.definition;
    // A listener with no cursor starts now. A wait records that, and listening
    // again from it gets the ticks since.
    const from = asked ?? schedule?.begin(Date.now()) ?? null;
    const { stream, listener } = createListenerStream(this.listeners, request, {
      cursor: from,
    });
    if (request.signal.aborted) {
      return stream;
    }
    this.listeners.add(listener);
    if (listener.stores) {
      this.expectStore(request);
    }
    const run = new AbortController();
    const stop = (): void => run.abort();
    listener.onEnd.add(stop);
    this.controller.signal.addEventListener('abort', stop, {
      once: true,
    });
    const deliver = async (event: SourceEmitEvent): Promise<void> => {
      const init = this.stamp(event);
      if (listener.stores) {
        await handToStore(listener, init);
        return;
      }
      listener.push({
        type: 'event',
        event: init,
      });
    };
    void (async (): Promise<void> => {
      await start?.call(this.definition, {
        emit: deliver,
        cursor: from,
        signal: run.signal,
      });
    })().catch((e: unknown) => {
      // Most often its event could not be stored. The listener is told the stream
      // ended; a trigger listens again from its cursor and gets the event then.
      listener.push({
        type: 'terminated',
        reason: `source stopped: ${e instanceof Error ? e.message : String(e)}`,
      });
      listener.end();
    });
    return stream;
  }

  /**
   * Remember that `request`'s event type is one a trigger stores, until that
   * trigger stops for good (its signal is aborted), not merely until its stream ends.
   */
  private expectStore(request: ListenRequest): void {
    const type = request.event;
    const { signal } = request;
    if (signal.aborted) {
      return;
    }
    this.storers.set(type, (this.storers.get(type) ?? 0) + 1);
    signal.addEventListener(
      'abort',
      () => {
        const left = (this.storers.get(type) ?? 1) - 1;
        if (left > 0) {
          this.storers.set(type, left);
          return;
        }
        this.storers.delete(type);
      },
      {
        once: true,
      },
    );
  }

  /** Where the source is now, as a cursor: after its last event, or before any. */
  private position(): string | null {
    if (!this.definition.start) {
      return null;
    }
    const newest = this.history.at(-1);
    if (!newest) {
      return this.emitted === 0 ? SOURCE_ORIGIN : this.localPosition(this.emitted);
    }
    // The source's own cursor where it gives one. Where it does not, the event's
    // place in what this hub emitted: without that, "where the source is now" stayed
    // at the origin, and listening again from it replayed everything ever emitted.
    return newest.cursor ?? this.localPosition(this.emitted);
  }

  private localPosition(count: number): string {
    return `${LOCAL_POSITION}${this.epoch}:${count}`;
  }

  /** How many events had been emitted at `cursor`, when it is a position of this hub. */
  private localCount(cursor: string): number | undefined {
    const prefix = `${LOCAL_POSITION}${this.epoch}:`;
    if (!cursor.startsWith(prefix)) {
      return undefined;
    }
    const count = Number(cursor.slice(prefix.length));
    return Number.isInteger(count) ? count : undefined;
  }

  /**
   * The events of `type` emitted after `cursor`. A cursor that is not in the history
   * is older than all of it — the source began after it — so everything is after it.
   */
  private since(cursor: string, type: string): ConnectionEventInit[] {
    const count = this.localCount(cursor);
    if (count !== undefined) {
      // The history holds the newest events: those after `count` are its tail.
      const after = Math.min(this.history.length, Math.max(0, this.emitted - count));
      return this.history.slice(this.history.length - after).filter((e) => e.type === type);
    }
    const at =
      cursor === SOURCE_ORIGIN ? -1 : this.history.findLastIndex((e) => e.cursor === cursor);
    return this.history.slice(at + 1).filter((e) => e.type === type);
  }

  close(reason: string): void {
    this.controller.abort();
    this.endListeners(reason);
  }

  private endListeners(reason: string): void {
    for (const listener of [
      ...this.listeners,
    ]) {
      listener.push({
        type: 'terminated',
        reason,
      });
      listener.end();
    }
  }

  private startOnce(cursor: string | null): void {
    const start = this.definition.start;
    if (this.started || !start) {
      return;
    }
    this.started = true;
    const run = async (): Promise<void> => {
      await start.call(this.definition, {
        emit: (event) => this.emit(event),
        cursor,
        signal: this.controller.signal,
      });
    };
    void run().catch((e: unknown) => {
      // `start` threw, most often because an event it emitted could not be stored.
      // Its listeners are told the stream ended, and the source is left able to
      // start again: the next listener begins it from its own cursor.
      const reason = `source stopped: ${e instanceof Error ? e.message : String(e)}`;
      const stopped = this.controller;
      this.controller = new AbortController();
      this.started = false;
      stopped.abort();
      this.endListeners(reason);
    });
  }
}

//#endregion

//#region Public API

/**
 * @public
 * Defines an in-process event source to register as a harness connection.
 */
export const defineSource: DefineSource = <const E extends SourceEventSchemas>(
  definition: SourceDefinition<E>,
): ConnectionSource<E> => {
  let hub: SourceHub<E> | undefined;
  const hubFor = (): SourceHub<E> => {
    hub ??= new SourceHub(definition);
    return hub;
  };
  const manifest = manifestOf(definition.events, definition.start !== undefined);
  return {
    kind: 'source',
    events: definition.events,
    emit: (event) => hubFor().emit(event),
    async connect(_opts: ConnectOptions): Promise<ReadonlyArray<Connection>> {
      const current = hubFor();
      let resolveClosed: (value: { reason: string }) => void = () => undefined;
      const closed = new Promise<{
        reason: string;
      }>((resolve) => {
        resolveClosed = resolve;
      });
      const connection: Connection = {
        id: 'source',
        manifest,
        identity: {
          surface: 'x-source',
          instance: crypto.randomUUID(),
        },
        async call(op) {
          return {
            status: 'error',
            error: {
              code: 'undeclared',
              message: `a source has no operations ('${op}')`,
            },
          };
        },
        async read(resource) {
          throw invalidConnectionError(
            `A source has no resource '${resource}'.`,
            'Sources only deliver events.',
          );
        },
        listen: (request) => current.listen(request),
        ...(definition.schedule
          ? {
              schedule: definition.schedule,
            }
          : {}),
        tasks: {
          async get(taskId) {
            return {
              taskId,
              state: 'failed',
            };
          },
          async result() {
            return {
              status: 'error',
              error: {
                code: 'not_found',
                message: 'a source has no tasks',
              },
            };
          },
          async cancel() {},
          async respond() {},
        },
        onChange: () => () => undefined,
        closed,
        async release() {
          current.close('released');
          hub = undefined;
          resolveClosed({
            reason: 'released',
          });
        },
      };
      return [
        connection,
      ];
    },
  };
};

/**
 * @public
 * A source with one event, `tick`, delivered once per scheduled time of a
 * five-field cron `schedule` in `timezone` (default UTC), even after downtime.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for a malformed schedule or timezone.
 */
export const cron: Cron = (schedule, options) => {
  const parsed = parseCronSchedule(schedule, options?.timezone ?? 'UTC');
  const events: CronEvents = {
    tick: CronTickSchema,
  };
  /** Cursors found to be too far behind to catch up from: they stay so. */
  const abandoned = new Set<string>();
  /**
   * Where to count from: the cursor, or `now` when more runs were missed since the
   * cursor than a restart replays. The schedule and the source both ask here, so
   * the time the schedule says is due is one the source will deliver.
   */
  const resumeFrom = (cursor: string | null, now: number): number => {
    const resumed = cursor === null ? Number.NaN : Date.parse(cursor);
    if (cursor === null || Number.isNaN(resumed) || abandoned.has(cursor)) {
      return now;
    }
    let at = resumed;
    for (let missed = 0; missed <= CRON_CATCH_UP_LIMIT; missed += 1) {
      const next = nextCronRun(parsed, at);
      if (next === undefined || next > now) {
        return resumed;
      }
      at = next;
    }
    abandoned.add(cursor);
    return now;
  };
  return defineSource({
    events,
    schedule: {
      next: (cursor, now) => nextCronRun(parsed, resumeFrom(cursor, now)),
      begin: (now) => new Date(now).toISOString(),
    },
    async start({ emit, cursor, signal }) {
      let after = resumeFrom(cursor, Date.now());
      for (;;) {
        const next = nextCronRun(parsed, after);
        if (next === undefined || signal.aborted) {
          return;
        }
        const wait = next - Date.now();
        if (wait > 0 && !(await sleep(wait, signal))) {
          return;
        }
        const scheduledFor = new Date(next).toISOString();
        await emit({
          type: 'tick',
          id: scheduledFor,
          cursor: scheduledFor,
          payload: {
            scheduledFor,
          },
        });
        after = next;
      }
    },
  });
};

//#endregion
