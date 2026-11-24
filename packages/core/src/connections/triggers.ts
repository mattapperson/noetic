/**
 * Triggers (spec 35 § Triggers, § Events). A trigger starts or joins a turn
 * when a connection reports an event. Triggers listen for the life of the
 * harness. Each matching event is written to a durable inbox together with the
 * advanced cursor, delivered as a turn with message id
 * `<connection>:<trigger>:<event id>` on its thread — `thread(event)`, else
 * the profile's natural thread for the event, else the trigger id — and
 * recorded as done when its turn completes. Events are deduplicated per
 * trigger, so a trigger delivers each event once, even across crashes: on
 * start, undelivered inbox entries are delivered again before listening
 * resumes from the recorded cursor.
 */

import type {
  ConnectionEvent,
  ConnectionEventInit,
  ConnectionTrigger,
  StorageAdapter,
} from '@noetic-tools/types';
import { ConnectionUnsatisfiedError } from '@noetic-tools/types';
import { z } from 'zod';
import type { CompiledExpression } from '../expression/jsonata';
import { compileExpression, compute, computeMaybe, passes } from '../expression/jsonata';
import { invalidConnectionError, unknownConnectionError } from './errors';
import type { ConnectionRuntime } from './registry';
import { isPlainRecord } from './values';

//#region Types

/** One event a trigger hands to the harness as a turn. */
export interface TriggerDelivery {
  readonly trigger: string;
  readonly connection: string;
  readonly threadId: string;
  /** `<connection>:<trigger>:<event id>`. */
  readonly messageId: string;
  readonly input: string;
  /** The event as the turn sees it: stamped, refs sealed to `threadId`, secrets scrubbed. */
  readonly event: ConnectionEvent;
}

/** What a `TriggerRunner` needs. */
export interface TriggerRunnerOptions {
  readonly runtime: ConnectionRuntime;
  readonly triggers: ReadonlyArray<ConnectionTrigger>;
  readonly storage: StorageAdapter;
  /** Starts the turn; resolves when it completes (then the event is recorded as done). */
  readonly deliver: (delivery: TriggerDelivery) => Promise<void>;
  /** A delivery or listen failure. Default: a console warning. */
  readonly onError?: (trigger: string, error: unknown) => void;
  /** Delay before re-listening after a stream ended, by attempt. Default: 1 s doubling to 30 s. */
  readonly relistenDelayMs?: (attempt: number) => number;
  /** Delay before retrying a failed delivery, by attempt. Default: 1 s doubling to 30 s. */
  readonly redeliverDelayMs?: (attempt: number) => number;
  /** The clock scheduled events are counted by. Default `Date.now`. */
  readonly now?: () => number;
}

/** A trigger's expressions, compiled once. A field written as a function has none. */
interface CompiledTrigger {
  readonly filter?: CompiledExpression;
  readonly input?: CompiledExpression;
  readonly thread?: CompiledExpression;
}

/** How long `idle` waits for a due event to be read before it stops waiting on it. */
const DUE_WAIT_MS = 1e4;
const DUE_POLL_MS = 10;

interface InboxEntry {
  readonly event: ConnectionEvent;
  readonly threadId: string;
  readonly input: string;
  readonly messageId: string;
}

//#endregion

//#region Constants

/** Deliveries of one event tried before the trigger gives up on it. */
const MAX_DELIVERY_ATTEMPTS = 5;

/** A trigger as stored: only its data. A trigger with a function in it is not stored. */
const StoredTriggerSchema = z.object({
  id: z.string().min(1),
  connection: z.string().min(1),
  event: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  filter: z.string().optional(),
  input: z.string(),
  thread: z.string().optional(),
});

/** Where triggers added while the harness runs are kept. */
const STORED_PREFIX = 'noetic/connections/triggers-added/';

const InboxEntrySchema = z.object({
  event: z.object({
    id: z.string(),
    type: z.string(),
    time: z.string(),
    payload: z.unknown(),
    cursor: z.string().nullable(),
    connection: z.string(),
    actionId: z.string().optional(),
  }),
  threadId: z.string(),
  input: z.string(),
  messageId: z.string(),
});

//#endregion

//#region Helpers

function prefix(triggerId: string): string {
  return `noetic/connections/triggers/${triggerId}`;
}

/**
 * Compile a trigger's expressions.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when one does not parse.
 */
function compileTrigger(trigger: ConnectionTrigger): CompiledTrigger {
  const compiled: {
    filter?: CompiledExpression;
    input?: CompiledExpression;
    thread?: CompiledExpression;
  } = {};
  for (const field of [
    'filter',
    'input',
    'thread',
  ] as const) {
    const source = trigger[field];
    if (typeof source !== 'string') {
      continue;
    }
    try {
      compiled[field] = compileExpression(source, `trigger '${trigger.id}' ${field}`);
    } catch (e) {
      throw invalidConnectionError(
        `Trigger '${trigger.id}' has a ${field} expression that does not parse: ${e instanceof Error ? e.message : String(e)}`,
        'Fix the JSONata syntax; the expression reads the event as `event`.',
      );
    }
  }
  return compiled;
}

/** True when a trigger is plain data, so it can be kept in storage. */
function isData(trigger: ConnectionTrigger): boolean {
  return (
    typeof trigger.input === 'string' &&
    (trigger.filter === undefined || typeof trigger.filter === 'string') &&
    (trigger.thread === undefined || typeof trigger.thread === 'string')
  );
}

function defaultDelay(attempt: number): number {
  return Math.min(3e4, 1e3 * 2 ** attempt);
}

function naturalThread(event: ConnectionEvent, field: string | undefined): string | undefined {
  if (!field || !isPlainRecord(event.payload)) {
    return undefined;
  }
  const value = event.payload[field];
  if (isPlainRecord(value) && isPlainRecord(value.$ref) && typeof value.$ref.id === 'string') {
    return `${event.connection}:${value.$ref.id}`;
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      {
        once: true,
      },
    );
  });
}

//#endregion

//#region Public API

/**
 * Checks triggers against the harness connections at construction.
 *
 * @throws NoeticConfigError `CONNECTION_UNKNOWN` for a trigger naming an unknown connection,
 * `CONNECTION_INVALID` for a missing or repeated trigger id or a missing event.
 */
export function validateTriggers(
  triggers: ReadonlyArray<ConnectionTrigger>,
  names: ReadonlyArray<string>,
): void {
  const ids = new Set<string>();
  for (const trigger of triggers) {
    if (!trigger.id || ids.has(trigger.id)) {
      throw invalidConnectionError(
        `Trigger id '${trigger.id}' is missing or used twice.`,
        'Give every trigger a unique, non-empty id.',
      );
    }
    ids.add(trigger.id);
    if (!names.includes(trigger.connection)) {
      throw unknownConnectionError(trigger.connection, names);
    }
    if (!trigger.event) {
      throw invalidConnectionError(
        `Trigger '${trigger.id}' names no event.`,
        "Set the event the trigger listens for, e.g. event: 'chat.message.created'.",
      );
    }
    compileTrigger(trigger);
  }
}

/** Runs a harness's triggers for its lifetime. */
export class TriggerRunner {
  private readonly controller = new AbortController();
  private readonly triggers = new Map<string, ConnectionTrigger>();
  private readonly compiled = new Map<string, CompiledTrigger>();
  /** Each trigger's listen loop, and what stops it. */
  private readonly loops = new Map<
    string,
    {
      controller: AbortController;
      done: Promise<void>;
    }
  >();
  private started = false;
  /**
   * The last delivery on each thread. A thread's events are delivered one turn
   * at a time, so each matching event starts its own turn instead of joining
   * a queued one (spec 35 § Triggers).
   */
  private readonly threads = new Map<string, Promise<void>>();

  constructor(private readonly options: TriggerRunnerOptions) {
    for (const trigger of options.triggers) {
      this.triggers.set(trigger.id, trigger);
      this.compiled.set(trigger.id, compileTrigger(trigger));
    }
  }

  /**
   * Loads the triggers added on an earlier run, redelivers undelivered inbox
   * entries, and starts listening.
   *
   * @throws ConnectionUnsatisfiedError when a trigger's connection does not offer its event.
   */
  async start(): Promise<void> {
    await this.loadAdded();
    for (const trigger of this.triggers.values()) {
      this.requireEvent(trigger);
    }
    this.started = true;
    for (const trigger of this.triggers.values()) {
      await this.begin(trigger);
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(
      [
        ...this.loops.values(),
      ].map((loop) => loop.done),
    );
  }

  /** Every trigger the runner has: the harness's own, and those added while it ran. */
  list(): ConnectionTrigger[] {
    return [
      ...this.triggers.values(),
    ];
  }

  /**
   * Add a trigger while the harness runs. One written with expressions only is kept
   * in storage and is there again after a restart; one with a function in it lasts
   * for this process.
   *
   * @throws NoeticConfigError `CONNECTION_INVALID` for an id already in use, a
   *   missing event or an expression that does not parse; `CONNECTION_UNKNOWN` for
   *   an unknown connection.
   * @throws ConnectionUnsatisfiedError when the connection does not offer the event.
   */
  async add(trigger: ConnectionTrigger): Promise<void> {
    validateTriggers(
      [
        ...this.triggers.values(),
        trigger,
      ],
      this.options.runtime.names(),
    );
    this.requireEvent(trigger);
    this.triggers.set(trigger.id, trigger);
    this.compiled.set(trigger.id, compileTrigger(trigger));
    if (isData(trigger)) {
      await this.options.storage.set(`${STORED_PREFIX}${trigger.id}`, trigger);
    }
    if (this.started) {
      await this.begin(trigger);
    }
  }

  /** Stop and forget a trigger. Resolves false when there is none with that id. */
  async remove(id: string): Promise<boolean> {
    if (!this.triggers.has(id)) {
      return false;
    }
    this.triggers.delete(id);
    this.compiled.delete(id);
    const loop = this.loops.get(id);
    this.loops.delete(id);
    loop?.controller.abort();
    await loop?.done;
    await this.options.storage.delete(`${STORED_PREFIX}${id}`);
    return true;
  }

  /**
   * Epoch ms of the earliest event a trigger is due, for triggers on a connection
   * that can tell (`Connection.schedule`, as `cron()` has). Undefined when none can,
   * or before the runner has started.
   */
  async nextDue(): Promise<number | undefined> {
    const now = (this.options.now ?? Date.now)();
    let earliest: number | undefined;
    for (const trigger of this.triggers.values()) {
      const schedule = this.options.runtime.current(trigger.connection)?.schedule;
      if (!schedule) {
        continue;
      }
      const due = schedule.next(await this.cursorOf(trigger), now);
      if (due !== undefined) {
        earliest = earliest === undefined ? due : Math.min(earliest, due);
      }
    }
    return earliest;
  }

  /**
   * Resolves once the runner has nothing in hand: every scheduled event that is
   * due has been read, and every turn a trigger started has finished or parked.
   * It gives up waiting on a due event after `dueWaitMs`, so a source that cannot
   * deliver does not hold a caller forever.
   */
  async idle(dueWaitMs = DUE_WAIT_MS): Promise<void> {
    const now = this.options.now ?? Date.now;
    const giveUpAt = Date.now() + dueWaitMs;
    for (;;) {
      await Promise.allSettled([
        ...this.threads.values(),
      ]);
      const due = await this.nextDue();
      const overdue = due !== undefined && due <= now() && Date.now() < giveUpAt;
      if (!overdue && this.threads.size === 0) {
        return;
      }
      await wait(DUE_POLL_MS, this.controller.signal);
      if (this.controller.signal.aborted) {
        return;
      }
    }
  }

  private async cursorOf(trigger: ConnectionTrigger): Promise<string | null> {
    const cursor = await this.options.storage.get<string>(`${prefix(trigger.id)}/cursor`);
    return typeof cursor === 'string' ? cursor : null;
  }

  /**
   * A trigger on a scheduled connection starts counting from now. Without a stored
   * place to count from, a host that is not running when the first event falls due
   * would come back, count from "now" again, and never see it.
   */
  private async anchor(trigger: ConnectionTrigger): Promise<void> {
    const schedule = this.options.runtime.current(trigger.connection)?.schedule;
    if (!schedule || (await this.cursorOf(trigger)) !== null) {
      return;
    }
    await this.advance(trigger, schedule.begin((this.options.now ?? Date.now)()));
  }

  /** Triggers added on an earlier run, read back from storage. */
  private async loadAdded(): Promise<void> {
    for (const key of await this.options.storage.list(STORED_PREFIX)) {
      const parsed = StoredTriggerSchema.safeParse(await this.options.storage.get(key));
      if (!parsed.success || this.triggers.has(parsed.data.id)) {
        continue;
      }
      try {
        this.compiled.set(parsed.data.id, compileTrigger(parsed.data));
        this.triggers.set(parsed.data.id, parsed.data);
      } catch (e) {
        this.report(parsed.data.id, e);
      }
    }
  }

  private requireEvent(trigger: ConnectionTrigger): void {
    const manifest = this.options.runtime.current(trigger.connection)?.manifest;
    if (manifest && !manifest.events[trigger.event]) {
      throw new ConnectionUnsatisfiedError({
        connection: trigger.connection,
        missing: {
          kind: 'event',
          event: trigger.event,
        },
      });
    }
  }

  /** Redeliver what the trigger left in its inbox, then listen. */
  private async begin(trigger: ConnectionTrigger): Promise<void> {
    await this.redeliver(trigger);
    await this.anchor(trigger);
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    this.controller.signal.addEventListener('abort', stop, {
      once: true,
    });
    if (this.controller.signal.aborted) {
      stop();
    }
    this.loops.set(trigger.id, {
      controller,
      done: this.listenLoop(trigger, controller.signal),
    });
  }

  private report(trigger: string, error: unknown): void {
    if (this.options.onError) {
      this.options.onError(trigger, error);
      return;
    }
    console.warn(`[noetic] trigger '${trigger}':`, error);
  }

  private async redeliver(trigger: ConnectionTrigger): Promise<void> {
    const keys = await this.options.storage.list(`${prefix(trigger.id)}/inbox/`);
    for (const key of keys) {
      const parsed = InboxEntrySchema.safeParse(await this.options.storage.get(key));
      if (!parsed.success) {
        await this.options.storage.delete(key);
        continue;
      }
      this.deliver(trigger, parsed.data, key);
    }
  }

  private async listenLoop(trigger: ConnectionTrigger, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const ended = await this.listenOnce(trigger, signal);
        if (ended) {
          attempt = 0;
        }
      } catch (e) {
        this.report(trigger.id, e);
      }
      if (signal.aborted) {
        return;
      }
      await wait((this.options.relistenDelayMs ?? defaultDelay)(attempt), signal);
      attempt += 1;
    }
  }

  /** Listens until the stream ends. Returns whether it got as far as listening. */
  private async listenOnce(trigger: ConnectionTrigger, signal: AbortSignal): Promise<boolean> {
    const stream = await this.options.runtime.listenRaw(trigger.connection, {
      event: trigger.event,
      arguments: trigger.arguments,
      cursor: await this.cursorOf(trigger),
      signal,
      // A source's `emit` waits to hear the event is in the inbox.
      stores: true,
    });
    await stream.ready;
    for await (const message of stream) {
      if (signal.aborted) {
        break;
      }
      if (message.type === 'event') {
        try {
          await this.handle(trigger, message.event);
        } catch (e) {
          message.stored?.(e);
          throw e;
        }
        message.stored?.();
        continue;
      }
      this.options.runtime.emit({
        type: 'stream_changed',
        data: {
          connection: trigger.connection,
          event: trigger.event,
          change: message.type === 'gap' ? 'gap' : 'ended',
          reason: message.reason,
        },
      });
      if (message.type === 'terminated') {
        break;
      }
    }
    await stream.close();
    return true;
  }

  private async handle(trigger: ConnectionTrigger, init: ConnectionEventInit): Promise<void> {
    const storage = this.options.storage;
    const base = prefix(trigger.id);
    const inboxKey = `${base}/inbox/${encodeURIComponent(init.id)}`;
    const seenKey = `${base}/seen/${encodeURIComponent(init.id)}`;
    const duplicate =
      (await storage.get(seenKey)) !== null || (await storage.get(inboxKey)) !== null;
    if (duplicate) {
      await this.advance(trigger, init.cursor);
      return;
    }
    let entry: InboxEntry | undefined;
    try {
      entry = await this.entryFor(trigger, init);
    } catch (e) {
      // A filter or input that throws on one event gives up on it rather than
      // re-reading it from the same cursor forever.
      this.report(trigger.id, e);
      await storage.set(seenKey, {
        failed: e instanceof Error ? e.message : String(e),
      });
      await this.advance(trigger, init.cursor);
      return;
    }
    if (!entry) {
      await this.advance(trigger, init.cursor);
      return;
    }
    await storage.set<InboxEntry>(inboxKey, entry);
    await this.advance(trigger, init.cursor);
    this.options.runtime.emit({
      type: 'connection_event',
      data: {
        connection: trigger.connection,
        trigger: trigger.id,
        event: entry.event,
      },
    });
    this.deliver(trigger, entry, inboxKey);
  }

  /** The inbox entry for an event, or `undefined` when the trigger's filter rejects it. */
  private async entryFor(
    trigger: ConnectionTrigger,
    init: ConnectionEventInit,
  ): Promise<InboxEntry | undefined> {
    const runtime = this.options.runtime;
    const compiled = this.compiled.get(trigger.id) ?? {};
    const stamped: ConnectionEvent = {
      ...init,
      connection: trigger.connection,
    };
    const field = runtime.current(trigger.connection)?.manifest.events[trigger.event]?.thread;
    const threadId =
      (await threadOf(trigger, compiled, stamped)) ?? naturalThread(stamped, field) ?? trigger.id;
    const payload = await runtime.admit(trigger.connection, init.payload, {
      threadId,
      executionId: `trigger:${trigger.id}`,
    });
    const event: ConnectionEvent = {
      ...stamped,
      payload,
    };
    if (!(await lets(trigger, compiled, event))) {
      return undefined;
    }
    return {
      event,
      threadId,
      input: await inputOf(trigger, compiled, event),
      messageId: `${trigger.connection}:${trigger.id}:${init.id}`,
    };
  }

  private async advance(trigger: ConnectionTrigger, cursor: string | null): Promise<void> {
    if (cursor === null) {
      return;
    }
    await this.options.storage.set(`${prefix(trigger.id)}/cursor`, cursor);
  }

  private deliver(trigger: ConnectionTrigger, entry: InboxEntry, inboxKey: string): void {
    const previous = this.threads.get(entry.threadId) ?? Promise.resolve();
    const next = previous.then(() =>
      this.deliverWithRetry(trigger, {
        entry,
        inboxKey,
      }),
    );
    this.threads.set(entry.threadId, next);
    void next.finally(() => {
      if (this.threads.get(entry.threadId) === next) {
        this.threads.delete(entry.threadId);
      }
    });
  }

  /**
   * Delivers one inbox entry, retrying a failed turn with backoff. On success the
   * event is marked done. After the last try the trigger gives up: the failure is
   * reported, the event is marked seen so it is not delivered again, and nothing
   * more is kept. A host that wants another try emits the event again itself.
   */
  private async deliverWithRetry(
    trigger: ConnectionTrigger,
    at: {
      entry: InboxEntry;
      inboxKey: string;
    },
  ): Promise<void> {
    const { entry, inboxKey } = at;
    const storage = this.options.storage;
    const base = prefix(trigger.id);
    const eventKey = encodeURIComponent(entry.event.id);
    const seenKey = `${base}/seen/${eventKey}`;
    const signal = this.controller.signal;
    let lastError = '';
    let attempts = 0;
    for (; attempts < MAX_DELIVERY_ATTEMPTS && !signal.aborted; attempts++) {
      try {
        await this.options.deliver({
          trigger: trigger.id,
          connection: trigger.connection,
          threadId: entry.threadId,
          messageId: entry.messageId,
          input: entry.input,
          event: entry.event,
        });
        await storage.set(seenKey, true);
        await storage.delete(inboxKey);
        return;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        this.report(trigger.id, e);
      }
      await wait((this.options.redeliverDelayMs ?? defaultDelay)(attempts), signal);
    }
    // Stopped part way: the inbox entry stays and is delivered again on the next start.
    if (attempts < MAX_DELIVERY_ATTEMPTS) {
      return;
    }
    await storage.set(seenKey, {
      failed: lastError,
    });
    await storage.delete(inboxKey);
  }
}

/** The thread a trigger names for an event, by its function or its expression. */
async function threadOf(
  trigger: ConnectionTrigger,
  compiled: CompiledTrigger,
  event: ConnectionEvent,
): Promise<string | undefined> {
  if (typeof trigger.thread === 'function') {
    return trigger.thread(event);
  }
  if (!compiled.thread) {
    return undefined;
  }
  const value = await computeMaybe(compiled.thread, {
    event,
  });
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Whether a trigger's filter lets an event through. */
async function lets(
  trigger: ConnectionTrigger,
  compiled: CompiledTrigger,
  event: ConnectionEvent,
): Promise<boolean> {
  if (typeof trigger.filter === 'function') {
    return trigger.filter(event);
  }
  if (!compiled.filter) {
    return true;
  }
  return passes(compiled.filter, {
    event,
  });
}

/** The message a trigger starts its turn with. An expression's value that is not text is sent as JSON. */
async function inputOf(
  trigger: ConnectionTrigger,
  compiled: CompiledTrigger,
  event: ConnectionEvent,
): Promise<string> {
  if (typeof trigger.input === 'function') {
    return trigger.input(event);
  }
  if (!compiled.input) {
    return '';
  }
  const value = await compute(compiled.input, {
    event,
  });
  return typeof value === 'string' ? value : JSON.stringify(value);
}

//#endregion
