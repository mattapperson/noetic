/**
 * Triggers route connection events to workflow turns (spec 35 § Triggers).
 * The inbox holds work before a cursor moves or delivery begins. Receipts
 * suppress duplicate events, and any pending entry is delivered on startup.
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
import type { InboxEntry, TriggerOutcome } from './trigger-outcomes';
import { InboxEntrySchema, inboxOutcome, seenOutcome } from './trigger-outcomes';
import type { PayloadCheck } from './trigger-shape';
import { checkTrigger } from './trigger-shape';
import { isPlainRecord } from './values';

/** How many times an event is read before a trigger gives up on turning it into a turn. */
const ENTRY_ATTEMPTS = 3;

//#region Types

/** @public One event a trigger hands to the harness as a turn. */
export interface TriggerDelivery {
  readonly trigger: string;
  readonly connection: string;
  readonly threadId: string;
  /** Stable across delivery attempts and replay. */
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
  /** A trigger on a scheduled connection moved on, so its next event is a new one. */
  readonly onSchedule?: () => Promise<void>;
}

/** An event whose payload is not the shape its trigger takes. It is wrong every time it is read. */
class Misfit extends Error {}

/** A trigger's expressions, compiled once. A field written as a function has none. */
interface CompiledTrigger {
  readonly filter?: CompiledExpression;
  readonly input?: CompiledExpression;
  readonly thread?: CompiledExpression;
}

/** How long `idle` waits for a due event to be read before it stops waiting on it. */
const DUE_WAIT_MS = 1e4;
const DUE_POLL_MS = 10;

//#endregion

//#region Constants

/** Deliveries of one event tried before the trigger gives up on it. */
const MAX_DELIVERY_ATTEMPTS = 5;

/** A trigger as stored: only its data. A trigger with a function or a zod schema in it is not stored. */
const StoredTriggerSchema = z.object({
  id: z.string().min(1),
  connection: z.string().min(1),
  event: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  filter: z.string().optional(),
  input: z.string(),
  thread: z.string().optional(),
});

/** Where triggers added while the harness runs are kept. */
const STORED_PREFIX = 'noetic/connections/triggers-added/';

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
    !(trigger.payload instanceof z.ZodType) &&
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
  /**
   * Each trigger's payload check, once its connection has said what the event
   * carries. Kept by the trigger itself, not its id, so one added under a
   * removed trigger's id never takes that trigger's check.
   */
  private readonly shapes = new WeakMap<ConnectionTrigger, PayloadCheck>();
  /** Each trigger's listen loop, and what stops it. */
  private readonly loops = new Map<
    string,
    {
      controller: AbortController;
      done: Promise<void>;
    }
  >();
  private started = false;
  private readonly removing = new Set<string>();
  private readonly adding = new Map<string, ConnectionTrigger>();
  private readonly accepting = new Map<string, Promise<unknown>>();
  /**
   * Inbox entries being delivered, by key, each with the trigger delivering it:
   * a trigger added again under a removed one's id is not held up by its turns.
   */
  private readonly active = new Map<string, ConnectionTrigger>();
  /**
   * The last delivery on each thread. A thread's events are delivered one turn
   * at a time, so each matching event starts its own turn instead of joining
   * a queued one (spec 35 § Triggers).
   */
  private readonly threads = new Map<string, Promise<void>>();
  /** Events being stored right now, whose turns do not exist yet. */
  private handling = 0;
  /** How often reading an event into an inbox entry has failed, by inbox key. */
  private readonly entryTries = new Map<string, number>();

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
    const added = await this.loadAdded();
    for (const trigger of [
      ...this.triggers.values(),
    ]) {
      if (!added.has(trigger.id)) {
        this.requireEvent(trigger);
        continue;
      }
      // A trigger kept from an earlier run may name an event its connection no
      // longer offers. That stops this trigger, not every other one.
      try {
        this.requireEvent(trigger);
      } catch (e) {
        this.report(trigger.id, e);
        this.triggers.delete(trigger.id);
        this.compiled.delete(trigger.id);
      }
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
    await Promise.allSettled(this.accepting.values());
  }

  /** Every trigger the runner has: the harness's own, and those added while it ran. */
  list(): ConnectionTrigger[] {
    return [
      ...this.triggers.values(),
    ];
  }

  /**
   * Add a trigger while the harness runs. One written with expressions only is kept
   * in storage and is there again after a restart; one with a function or a zod `payload` in it lasts
   * for this process.
   *
   * @throws NoeticConfigError `CONNECTION_INVALID` for an id already in use, a
   *   missing event or an expression that does not parse; `CONNECTION_UNKNOWN` for
   *   an unknown connection.
   * @throws ConnectionUnsatisfiedError when the connection does not offer the event.
   */
  async add(trigger: ConnectionTrigger): Promise<void> {
    if (this.removing.has(trigger.id)) {
      throw invalidConnectionError(
        `Trigger '${trigger.id}' is being removed.`,
        'Wait for removal to finish.',
      );
    }
    validateTriggers(
      [
        ...this.triggers.values(),
        ...this.adding.values(),
        trigger,
      ],
      this.options.runtime.names(),
    );
    this.requireEvent(trigger);
    this.adding.set(trigger.id, trigger);
    try {
      if (isData(trigger)) {
        await this.options.storage.set(`${STORED_PREFIX}${trigger.id}`, trigger);
      }
      this.compiled.set(trigger.id, compileTrigger(trigger));
      this.triggers.set(trigger.id, trigger);
    } finally {
      this.adding.delete(trigger.id);
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
    this.removing.add(id);
    try {
      this.triggers.delete(id);
      this.compiled.delete(id);
      const loop = this.loops.get(id);
      this.loops.delete(id);
      loop?.controller.abort();
      await loop?.done;
      await this.accepting.get(id)?.catch(() => {});
      await this.options.storage.delete(`${STORED_PREFIX}${id}`);
      // What it had in hand goes with it: a trigger added later under this id starts
      // clean, not from this one's cursor and its list of events already seen.
      for (const key of await this.options.storage.list(`${prefix(id)}/`)) {
        await this.options.storage.delete(key);
      }
    } finally {
      this.removing.delete(id);
    }
    return true;
  }

  /** Pick up accepted work after a store failure on a warm runner. */
  async recover(): Promise<void> {
    if (!this.started || this.controller.signal.aborted) {
      return;
    }
    for (const trigger of this.triggers.values()) {
      await this.redeliver(trigger);
    }
  }

  /** List outcomes retained for a trigger, without event payloads. */
  async outcomes(id: string): Promise<TriggerOutcome[]> {
    const trigger = this.triggers.get(id);
    if (!trigger) {
      return [];
    }
    const base = prefix(trigger.id);
    const outcomes = new Map<string, TriggerOutcome>();
    for (const [path, parse] of [
      [
        `${base}/inbox/`,
        inboxOutcome,
      ],
      [
        `${base}/seen/`,
        seenOutcome,
      ],
    ] as const) {
      for (const key of await this.options.storage.list(path)) {
        const eventId = decodeURIComponent(key.slice(path.length));
        const outcome = parse(eventId, await this.options.storage.get(key));
        if (outcome) {
          outcomes.set(eventId, outcome);
        }
      }
    }
    return [
      ...outcomes.values(),
    ];
  }

  /**
   * Deliver again an event the trigger still holds, under the same event and
   * message ids. Resolves false when it holds none with that id to deliver: the
   * event was delivered, is being delivered now, or never became a turn.
   */
  async replay(id: string, eventId: string): Promise<boolean> {
    const trigger = this.triggers.get(id);
    if (!trigger || !this.started) {
      return false;
    }
    const { storage } = this.options;
    const key = `${prefix(trigger.id)}/inbox/${encodeURIComponent(eventId)}`;
    const seen = `${prefix(trigger.id)}/seen/${encodeURIComponent(eventId)}`;
    const ran = await this.withTrigger(trigger, async () => {
      const parsed = InboxEntrySchema.safeParse(await storage.get(key));
      if (
        !parsed.success ||
        this.active.get(key) === trigger ||
        (await storage.get(seen)) !== null
      ) {
        return false;
      }
      const { failure: _failure, ...entry } = parsed.data;
      await storage.set(key, entry);
      this.deliver(trigger, entry, key);
      return true;
    });
    return ran?.value ?? false;
  }

  /**
   * Runs `work` after the trigger's earlier work, so its storage is written by
   * one thing at a time. Resolves `undefined`, without running it, once the
   * trigger has stopped: removed, or (unless `afterClose`) the runner closed.
   */
  private withTrigger<T>(
    trigger: ConnectionTrigger,
    work: () => Promise<T>,
    afterClose = false,
  ): Promise<
    | {
        value: T;
      }
    | undefined
  > {
    const prev = this.accepting.get(trigger.id);
    const next = Promise.resolve(prev)
      .catch(() => {})
      .then(async () => {
        if (
          (!afterClose && this.controller.signal.aborted) ||
          this.triggers.get(trigger.id) !== trigger
        ) {
          return undefined;
        }
        return {
          value: await work(),
        };
      });
    this.accepting.set(trigger.id, next);
    return next.finally(() => {
      if (this.accepting.get(trigger.id) === next) {
        this.accepting.delete(trigger.id);
      }
    });
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
      if (!overdue && this.threads.size === 0 && this.handling === 0 && this.accepting.size === 0) {
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
  private async loadAdded(): Promise<Set<string>> {
    const added = new Set<string>();
    for (const key of await this.options.storage.list(STORED_PREFIX)) {
      const parsed = StoredTriggerSchema.safeParse(await this.options.storage.get(key));
      if (!parsed.success || this.triggers.has(parsed.data.id)) {
        continue;
      }
      try {
        this.compiled.set(parsed.data.id, compileTrigger(parsed.data));
        this.triggers.set(parsed.data.id, parsed.data);
        added.add(parsed.data.id);
      } catch (e) {
        this.report(parsed.data.id, e);
      }
    }
    return added;
  }

  /**
   * Checks the trigger against its connection, once the connection has said
   * what it offers.
   *
   * @throws ConnectionUnsatisfiedError when the connection does not offer the event.
   * @throws NoeticConfigError `CONNECTION_INVALID` when the trigger and the
   *   event disagree on arguments or payload.
   */
  private requireEvent(trigger: ConnectionTrigger): void {
    const manifest = this.options.runtime.current(trigger.connection)?.manifest;
    if (!manifest) {
      return;
    }
    const info = manifest.events[trigger.event];
    if (!info) {
      throw new ConnectionUnsatisfiedError({
        connection: trigger.connection,
        missing: {
          kind: 'event',
          event: trigger.event,
        },
      });
    }
    this.shapes.set(trigger, checkTrigger(trigger, info));
  }

  /** Redeliver what the trigger left in its inbox, then listen. */
  private async begin(trigger: ConnectionTrigger): Promise<void> {
    await this.withTrigger(trigger, async () => {
      await this.redeliver(trigger);
      await this.anchor(trigger);
    });
    // Removed while it was starting: `remove` found no loop to stop, so none starts.
    if (this.triggers.get(trigger.id) !== trigger) {
      return;
    }
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

  /** Say on the stream that this event will not be tried again, and which one it was. */
  private gaveUp(
    trigger: ConnectionTrigger,
    event: ConnectionEventInit,
    why: {
      attempts: number;
      error: string;
    },
  ): void {
    this.options.runtime.emit({
      type: 'trigger_gave_up',
      data: {
        connection: trigger.connection,
        trigger: trigger.id,
        event,
        ...why,
      },
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
      if (!parsed.success && this.triggers.get(trigger.id) === trigger) {
        await this.options.storage.delete(key);
        continue;
      }
      if (parsed.success && this.triggers.get(trigger.id) === trigger) {
        this.deliver(trigger, parsed.data, key);
      }
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
      checkpoint: async (cursor) => {
        const moved = await this.withTrigger(trigger, () => this.advance(trigger, cursor));
        if (!moved) {
          throw new Error(`Trigger '${trigger.id}' is stopped.`);
        }
      },
    });
    try {
      // A connection that was not connected when the trigger was first checked
      // is by now. A trigger that does not fit it reads no event: the fault is
      // the trigger's, and no event should be marked failed for it.
      if (!this.shapes.has(trigger)) {
        this.requireEvent(trigger);
      }
      await stream.ready;
      for await (const message of stream) {
        if (signal.aborted) {
          break;
        }
        if (message.type === 'event') {
          // In hand from here: storing the event and saying when the next is due come
          // before its turn exists, and `idle()` must not take that gap for rest.
          this.handling += 1;
          try {
            await this.handle(trigger, message.event);
          } catch (e) {
            message.stored?.(e);
            throw e;
          } finally {
            this.handling -= 1;
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
    } finally {
      await stream.close();
    }
    return true;
  }

  private async handle(trigger: ConnectionTrigger, init: ConnectionEventInit): Promise<void> {
    const storage = this.options.storage;
    const base = prefix(trigger.id);
    const inboxKey = `${base}/inbox/${encodeURIComponent(init.id)}`;
    const seenKey = `${base}/seen/${encodeURIComponent(init.id)}`;
    if ((await storage.get(seenKey)) !== null) {
      await this.advance(trigger, init.cursor);
      return;
    }
    const held = InboxEntrySchema.safeParse(await storage.get(inboxKey));
    if (held.success) {
      this.deliver(trigger, held.data, inboxKey);
      await this.advance(trigger, init.cursor);
      return;
    }
    let entry: InboxEntry | undefined;
    try {
      entry = await this.entryFor(trigger, init);
    } catch (e) {
      // It may be the event (a filter that throws on it) or the moment (a blob
      // that could not be stored just now). So it is tried again: the cursor is not
      // moved, the sender is told the event was not stored, and the stream is read
      // again from where it was. After a few tries it is given up on, rather than
      // re-read from the same cursor forever. A payload of the wrong shape is
      // wrong every time, so it is given up on at once.
      const tries = (this.entryTries.get(inboxKey) ?? 0) + 1;
      if (!(e instanceof Misfit) && tries < ENTRY_ATTEMPTS) {
        this.entryTries.set(inboxKey, tries);
        throw e;
      }
      this.entryTries.delete(inboxKey);
      this.report(trigger.id, e);
      const error = e instanceof Error ? e.message : String(e);
      this.gaveUp(trigger, init, {
        attempts: tries,
        error,
      });
      await storage.set(seenKey, {
        failed: error,
      });
      await this.advance(trigger, init.cursor);
      return;
    }
    this.entryTries.delete(inboxKey);
    if (!entry) {
      await this.advance(trigger, init.cursor);
      return;
    }
    await storage.set<InboxEntry>(inboxKey, entry);
    this.deliver(trigger, entry, inboxKey);
    await this.advance(trigger, init.cursor);
    this.options.runtime.emit({
      type: 'connection_event',
      data: {
        connection: trigger.connection,
        trigger: trigger.id,
        event: entry.event,
      },
    });
  }

  /** The inbox entry for an event, or `undefined` when the trigger's filter rejects it. */
  private async entryFor(
    trigger: ConnectionTrigger,
    init: ConnectionEventInit,
  ): Promise<InboxEntry | undefined> {
    const runtime = this.options.runtime;
    const compiled = this.compiled.get(trigger.id) ?? {};
    const misfit = this.shapes.get(trigger)?.(init.payload);
    if (misfit) {
      throw new Misfit(`Event '${init.id}' is not what trigger '${trigger.id}' takes: ${misfit}`);
    }
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
    if (this.options.runtime.current(trigger.connection)?.schedule) {
      await this.options.onSchedule?.();
    }
  }

  private deliver(trigger: ConnectionTrigger, entry: InboxEntry, inboxKey: string): void {
    if (entry.failure || this.active.get(inboxKey) === trigger) {
      return;
    }
    this.active.set(inboxKey, trigger);
    const previous = this.threads.get(entry.threadId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await this.deliverWithRetry(trigger, entry, inboxKey);
      } catch (e) {
        this.report(trigger.id, e);
      } finally {
        if (this.active.get(inboxKey) === trigger) {
          this.active.delete(inboxKey);
        }
        if (this.threads.get(entry.threadId) === next) {
          this.threads.delete(entry.threadId);
        }
      }
    });
    this.threads.set(entry.threadId, next);
  }

  /** Keep the inbox entry until a receipt lands, or mark it failed for replay. */
  private async deliverWithRetry(
    trigger: ConnectionTrigger,
    entry: InboxEntry,
    inboxKey: string,
  ): Promise<void> {
    const { storage } = this.options;
    const seenKey = `${prefix(trigger.id)}/seen/${encodeURIComponent(entry.event.id)}`;
    if ((await storage.get(seenKey)) !== null) {
      await this.keepOutcome(trigger, () => storage.delete(inboxKey));
      return;
    }
    const signal = this.controller.signal;
    const stopped = (): boolean => signal.aborted || this.triggers.get(trigger.id) !== trigger;
    let error = '';
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS && !stopped(); attempt++) {
      const failed = await this.tryDeliver(trigger, entry);
      // A turn that finished during shutdown still gets its receipt.
      if (stopped() && failed) {
        return;
      }
      if (!failed) {
        await this.keepOutcome(trigger, async () => {
          await storage.set(seenKey, {
            status: 'delivered',
            messageId: entry.messageId,
            threadId: entry.threadId,
          });
          await storage.delete(inboxKey);
        });
        return;
      }
      error = failed.error instanceof Error ? failed.error.message : String(failed.error);
      this.report(trigger.id, failed.error);
      if (attempt === MAX_DELIVERY_ATTEMPTS) {
        const saved = await this.keepOutcome(trigger, () =>
          storage.set(inboxKey, {
            ...entry,
            failure: {
              status: 'failed',
              attempts: attempt,
              error,
            },
          }),
        );
        if (saved) {
          this.gaveUp(trigger, entry.event, {
            attempts: attempt,
            error,
          });
        }
        return;
      }
      await wait((this.options.redeliverDelayMs ?? defaultDelay)(attempt - 1), signal);
    }
  }

  /** One delivery. Resolves with what went wrong, or nothing when the turn finished. */
  private async tryDeliver(
    trigger: ConnectionTrigger,
    entry: InboxEntry,
  ): Promise<
    | {
        error: unknown;
      }
    | undefined
  > {
    try {
      await this.options.deliver({
        trigger: trigger.id,
        connection: trigger.connection,
        threadId: entry.threadId,
        messageId: entry.messageId,
        input: entry.input,
        event: entry.event,
      });
      return undefined;
    } catch (error) {
      return {
        error,
      };
    }
  }

  /**
   * Writes an outcome behind the trigger's other work, which removal waits on.
   * Resolves whether it was written.
   */
  private async keepOutcome(
    trigger: ConnectionTrigger,
    write: () => Promise<void>,
  ): Promise<boolean> {
    try {
      return (await this.withTrigger(trigger, write, true)) !== undefined;
    } catch (e) {
      this.report(trigger.id, e);
      return false;
    }
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
