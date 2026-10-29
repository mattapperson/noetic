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

/** The live side of a source: its listeners, its pending events, and its one running `start`. */
class SourceHub<E extends SourceEventSchemas> {
  readonly listeners = new Set<Listener>();
  private readonly pending: ConnectionEventInit[] = [];
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
    for (const listener of targets) {
      listener.push({
        type: 'event',
        event: init,
      });
    }
  }

  listen(request: ListenRequest): EventStream {
    const { stream, listener } = createListenerStream(this.listeners, request, {
      cursor: request.cursor ?? null,
    });
    this.listeners.add(listener);
    const held = this.pending.filter((e) => e.type === request.event);
    for (const event of held) {
      this.pending.splice(this.pending.indexOf(event), 1);
      listener.push({
        type: 'event',
        event,
      });
    }
    this.startOnce(request.cursor ?? null);
    return stream;
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
