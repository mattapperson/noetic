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
}

interface InboxEntry {
  readonly event: ConnectionEvent;
  readonly threadId: string;
  readonly input: string;
  readonly messageId: string;
}

//#endregion

//#region Constants

/** Deliveries of one event tried in-process before it waits for the next start. */
const MAX_DELIVERY_ATTEMPTS = 5;

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
  }
}

/** Runs a harness's triggers for its lifetime. */
export class TriggerRunner {
  private readonly controller = new AbortController();
  private readonly loops: Promise<void>[] = [];
  /**
   * The last delivery on each thread. A thread's events are delivered one turn
   * at a time, so each matching event starts its own turn instead of joining
   * a queued one (spec 35 § Triggers).
   */
  private readonly threads = new Map<string, Promise<void>>();

  constructor(private readonly options: TriggerRunnerOptions) {}

  /**
   * Redelivers undelivered inbox entries and starts listening.
   *
   * @throws ConnectionUnsatisfiedError when a trigger's connection does not offer its event.
   */
  async start(): Promise<void> {
    for (const trigger of this.options.triggers) {
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
    for (const trigger of this.options.triggers) {
      await this.redeliver(trigger);
      this.loops.push(this.listenLoop(trigger));
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.loops);
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

  private async listenLoop(trigger: ConnectionTrigger): Promise<void> {
    const signal = this.controller.signal;
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
    const cursor = await this.options.storage.get<string>(`${prefix(trigger.id)}/cursor`);
    const stream = await this.options.runtime.listenRaw(trigger.connection, {
      event: trigger.event,
      arguments: trigger.arguments,
      cursor: typeof cursor === 'string' ? cursor : null,
      signal,
    });
    await stream.ready;
    for await (const message of stream) {
      if (signal.aborted) {
        break;
      }
      if (message.type === 'event') {
        await this.handle(trigger, message.event);
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
      // A filter or input that throws on one event dead-letters it rather than
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
    const stamped: ConnectionEvent = {
      ...init,
      connection: trigger.connection,
    };
    const field = runtime.current(trigger.connection)?.manifest.events[trigger.event]?.thread;
    const threadId = trigger.thread?.(stamped) ?? naturalThread(stamped, field) ?? trigger.id;
    const payload = await runtime.admit(trigger.connection, init.payload, {
      threadId,
      executionId: `trigger:${trigger.id}`,
    });
    const event: ConnectionEvent = {
      ...stamped,
      payload,
    };
    if (trigger.filter && !trigger.filter(event)) {
      return undefined;
    }
    return {
      event,
      threadId,
      input: trigger.input(event),
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
    const next = previous.then(() => this.deliverWithRetry(trigger, entry, inboxKey));
    this.threads.set(entry.threadId, next);
    void next.finally(() => {
      if (this.threads.get(entry.threadId) === next) {
        this.threads.delete(entry.threadId);
      }
    });
  }

  /** Delivers one inbox entry, retrying a failed turn with backoff; marks it done on success. */
  private async deliverWithRetry(
    trigger: ConnectionTrigger,
    entry: InboxEntry,
    inboxKey: string,
  ): Promise<void> {
    const storage = this.options.storage;
    const seenKey = `${prefix(trigger.id)}/seen/${encodeURIComponent(entry.event.id)}`;
    const signal = this.controller.signal;
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS && !signal.aborted; attempt++) {
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
        this.report(trigger.id, e);
      }
      await wait((this.options.redeliverDelayMs ?? defaultDelay)(attempt), signal);
    }
    // Still undelivered: the inbox entry stays and is delivered again on the next start.
  }
}

//#endregion
