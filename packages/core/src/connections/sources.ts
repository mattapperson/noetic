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
  /** The cursor of the last event emitted, when one carried a cursor. */
  private lastCursor: string | undefined;
  private started = false;
  private readonly controller = new AbortController();

  constructor(private readonly definition: SourceDefinition<E>) {}

  async emit(event: SourceEmitEvent): Promise<void> {
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
    const init: ConnectionEventInit = {
      id: event.id,
      type: event.type,
      time: event.time ?? new Date().toISOString(),
      payload: parsed.data,
      cursor: event.cursor ?? null,
    };
    if (this.definition.start) {
      this.history.push(init);
      if (this.history.length > WAIT_BUFFER_LIMIT) {
        this.history.shift();
      }
      if (init.cursor !== null) {
        this.lastCursor = init.cursor;
      }
    }
    const targets = [
      ...this.listeners,
    ].filter((l) => l.event === event.type);
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
    const { stream, listener } = createListenerStream(this.listeners, request, {
      // Where this listener starts: what it asked for, or where the source is now. A
      // wait records it, and listening again from it replays what came since.
      cursor: asked ?? this.position(),
    });
    this.listeners.add(listener);
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
    this.startOnce(asked === SOURCE_ORIGIN ? null : asked);
    return stream;
  }

  /** Where the source is now, as a cursor: after its last event, or before any. */
  private position(): string | null {
    if (!this.definition.start) {
      return null;
    }
    return this.lastCursor ?? SOURCE_ORIGIN;
  }

  /**
   * The events of `type` emitted after `cursor`. A cursor that is not in the history
   * is older than all of it — the source began after it — so everything is after it.
   */
  private since(cursor: string, type: string): ConnectionEventInit[] {
    const at =
      cursor === SOURCE_ORIGIN ? -1 : this.history.findLastIndex((e) => e.cursor === cursor);
    return this.history.slice(at + 1).filter((e) => e.type === type);
  }

  close(reason: string): void {
    this.controller.abort();
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
      this.close(`source stopped: ${e instanceof Error ? e.message : String(e)}`);
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
  return defineSource({
    events,
    async start({ emit, cursor, signal }) {
      const resumed = cursor === null ? Number.NaN : Date.parse(cursor);
      let after = Number.isNaN(resumed) ? Date.now() : resumed;
      let caughtUp = 0;
      for (;;) {
        const next = nextCronRun(parsed, after);
        if (next === undefined || signal.aborted) {
          return;
        }
        const wait = next - Date.now();
        if (wait > 0 && !(await sleep(wait, signal))) {
          return;
        }
        if (wait <= 0) {
          caughtUp += 1;
        }
        if (caughtUp > CRON_CATCH_UP_LIMIT) {
          after = Date.now();
          caughtUp = 0;
          continue;
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
