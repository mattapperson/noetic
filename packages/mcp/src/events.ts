/**
 * Listening over the Events extension (SEP-3415). A stream uses the first of
 * webhook (`events/subscribe`, when the bridge has a receiver), push
 * (`events/stream`) and poll (`events/poll`) that the event type offers; callers
 * never see the difference. Webhook deliveries are verified (Standard Webhooks
 * signature, timestamp window). For a listener that does not store its events,
 * events are deduplicated by id within a stream and duplicate delivery ids are
 * dropped; one that stores them (`stores`) does that itself, so a sender may
 * deliver again what was not stored. A server that skipped ahead of the
 * cursor shows as a `gap`, and a subscription the server ended shows as
 * `terminated`.
 */

import type {
  ArtifactStore,
  ConnectionEventInit,
  EventStream,
  EventStreamMessage,
  ListenRequest,
} from '@noetic-tools/types';
import { WAIT_BUFFER_LIMIT } from '@noetic-tools/types';
import type { z } from 'zod';
import { storeInlineBlobs } from './content';
import type { McpSession } from './session';
import { pause } from './timing';
import type {
  McpWebhooks,
  SeenIds,
  WebhookDelivery,
  WebhookRegistration,
  WebhookReply,
} from './webhooks';
import { generateWebhookSecret, verifyWebhook } from './webhooks';
import type { EventDelivery, WireErrorSchema, WireEvent } from './wire';
import {
  EmptyResultSchema,
  McpMethod,
  McpNotification,
  PollResultSchema,
  StreamActiveParamsSchema,
  StreamErrorParamsSchema,
  StreamEventParamsSchema,
  StreamHeartbeatParamsSchema,
  SUBSCRIPTION_HEADER,
  SUBSCRIPTION_META,
  SubscribeResultSchema,
  WebhookControlSchema,
  WireEventSchema,
} from './wire';

//#region Types

/** @public What a stream needs from its connection. */
export interface EventContext {
  readonly session: McpSession;
  readonly artifacts: ArtifactStore;
  readonly meta: Readonly<Record<string, unknown>>;
  /** The modes the event type offers (`events/list`). */
  readonly delivery: ReadonlyArray<EventDelivery>;
  /** The shortest wait between polls, and the wait when the server suggests none. */
  readonly pollIntervalMs: number;
  readonly webhooks?: McpWebhooks;
  /** Seconds since the epoch; overridable for tests. */
  readonly nowSec?: () => number;
}

type Message = EventStreamMessage<ConnectionEventInit>;

type WireError = z.infer<typeof WireErrorSchema>;

//#endregion

//#region Message queue

/** A bounded async queue: overflow drops the oldest event and records a gap. */
class MessageQueue implements AsyncIterable<Message> {
  private readonly items: Message[] = [];
  private waiting: ((result: IteratorResult<Message>) => void) | undefined;
  private ended = false;
  private dropped = 0;

  push(message: Message): void {
    if (this.ended) {
      return;
    }
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({
        done: false,
        value: message,
      });
      return;
    }
    this.items.push(message);
    if (this.items.length > WAIT_BUFFER_LIMIT) {
      this.items.shift();
      this.dropped++;
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({
        done: true,
        value: undefined,
      });
    }
  }

  private next(): Promise<IteratorResult<Message>> {
    if (this.dropped > 0) {
      const count = this.dropped;
      this.dropped = 0;
      return Promise.resolve({
        done: false,
        value: {
          type: 'gap',
          reason: `buffer overflow: ${count} event(s) dropped`,
        },
      });
    }
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({
        done: false,
        value: item,
      });
    }
    if (this.ended) {
      return Promise.resolve({
        done: true,
        value: undefined,
      });
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<Message> {
    return {
      next: () => this.next(),
    };
  }
}

//#endregion

//#region Helpers

const SEEN_LIMIT = 1e4;

/** A set that forgets its oldest entries past a limit. */
class BoundedSet {
  private readonly order: string[] = [];
  private readonly set = new Set<string>();

  has(value: string): boolean {
    return this.set.has(value);
  }

  add(value: string): void {
    if (this.set.has(value)) {
      return;
    }
    this.set.add(value);
    this.order.push(value);
    if (this.order.length > SEEN_LIMIT) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.set.delete(oldest);
      }
    }
  }
}

/** What a `gap` says when the server started later than the cursor asked. */
const SKIPPED_AHEAD = 'the server skipped ahead of the cursor: events may be missing';

/** A stream with no message for this many heartbeats is dead (SEP-3415). */
const MISSED_HEARTBEATS = 3;

/** @public The delivery modes of `offered` this bridge can use, in the order it prefers them. */
export function deliveryModes(
  offered: ReadonlyArray<EventDelivery>,
  webhooks: McpWebhooks | undefined,
): EventDelivery[] {
  const preference: ReadonlyArray<EventDelivery> = [
    'webhook',
    'push',
    'poll',
  ];
  return preference.filter(
    (mode) => offered.includes(mode) && (mode !== 'webhook' || webhooks !== undefined),
  );
}

function ended(error: WireError): string {
  return error.code === undefined ? error.message : `${error.message} (${error.code})`;
}

/** A refresh is never sooner than this, whatever the clocks say. */
const REFRESH_FLOOR_MS = 1e3;

/** How long closing a stream waits for the server to drop its subscription. */
const UNSUBSCRIBE_TIMEOUT_MS = 5e3;

/**
 * @public
 * How long to wait before making a subscription again: halfway to
 * `refreshBefore`, so a slow answer still lands in time. Nothing for a
 * subscription that does not lapse.
 *
 * @throws Error when `refreshBefore` is not a time.
 */
export function refreshDelay(
  refreshBefore: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (typeof refreshBefore !== 'string') {
    return undefined;
  }
  const at = Date.parse(refreshBefore);
  if (Number.isNaN(at)) {
    throw new Error(`the server gave a refreshBefore that is not a time: '${refreshBefore}'`);
  }
  return Math.max(REFRESH_FLOOR_MS, (at - nowMs) / 2);
}

//#endregion

//#region Stream

class McpEventStream implements EventStream {
  readonly ready: Promise<{
    cursor: string | null;
  }>;
  private readonly queue = new MessageQueue();
  private readonly seen = new BoundedSet();
  private readonly controller = new AbortController();
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private settleReady: (value: { cursor: string | null }) => void = () => {};
  private failReady: (error: Error) => void = () => {};
  /** The webhook subscription's id, once the server has confirmed it. */
  private subscriptionId: string | undefined;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  /** How far the listener has read: what a webhook subscription is made again from. */
  private place: string | null;

  constructor(
    private readonly ctx: EventContext,
    private readonly req: ListenRequest,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.settleReady = resolve;
      this.failReady = reject;
    });
    this.ready.catch(() => {});
    this.place = req.cursor ?? null;
    if (req.signal.aborted) {
      void this.close();
      return;
    }
    req.signal.addEventListener('abort', () => void this.close(), {
      once: true,
    });
  }

  start(): void {
    this.run().catch((error: unknown) => this.fail(error));
  }

  private run(): Promise<void> {
    const starts: Record<EventDelivery, () => Promise<void>> = {
      webhook: () => this.startWebhook(),
      push: () => this.startPush(),
      poll: () => this.startPoll(),
    };
    const [mode] = deliveryModes(this.ctx.delivery, this.ctx.webhooks);
    if (mode === undefined) {
      return Promise.reject(
        new Error(`'${this.req.event}' offers no delivery mode this bridge can use`),
      );
    }
    return starts[mode]();
  }

  [Symbol.asyncIterator](): AsyncIterator<Message> {
    return this.queue[Symbol.asyncIterator]();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.controller.abort();
    this.failReady(new Error('the stream closed before the server confirmed it'));
    for (const cleanup of this.cleanups.splice(0)) {
      await Promise.resolve()
        .then(cleanup)
        .catch(() => {});
    }
    await this.chain.catch(() => {});
    this.queue.end();
  }

  private fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    this.failReady(new Error(reason));
    this.terminate(reason);
  }

  private terminate(reason: string): void {
    this.queue.push({
      type: 'terminated',
      reason,
    });
    void this.close();
  }

  private baseParams(): Record<string, unknown> {
    return {
      name: this.req.event,
      ...(this.req.arguments === undefined
        ? {}
        : {
            arguments: this.req.arguments,
          }),
      _meta: this.ctx.meta,
    };
  }

  private confirm(cursor: string | null | undefined): void {
    this.settleReady({
      cursor: cursor ?? null,
    });
  }

  private gap(): void {
    this.enqueue(async () => {
      this.queue.push({
        type: 'gap',
        reason: SKIPPED_AHEAD,
      });
    });
  }

  /**
   * Takes the place the server gives a subscription. It is recorded when the
   * listener had none, so one that stops before its first event comes back to
   * here and not to "now" again, and when the server skipped ahead to it.
   */
  private grant(cursor: string | null | undefined, truncated: boolean | undefined): void {
    if (truncated) {
      this.gap();
    }
    if (truncated || this.place === null) {
      this.commit(cursor);
    }
  }

  /**
   * Records how far the server has read, once every event before it is in hand.
   * A stream that failed on an earlier event records nothing: the listener must
   * read that event again, so its place stays behind it.
   */
  private commit(cursor: string | null | undefined): void {
    if (typeof cursor !== 'string') {
      return;
    }
    this.enqueue(async () => {
      if (this.closed) {
        return;
      }
      await this.req.checkpoint?.(cursor);
      this.place = cursor;
    });
  }

  /** Runs `work` after everything queued before it, keeping delivery in order. */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error: unknown) => this.fail(error));
  }

  private enqueueEvent(event: WireEvent): Promise<void> {
    if (event.name !== this.req.event || (!this.req.stores && this.seen.has(event.eventId))) {
      return Promise.resolve();
    }
    if (!this.req.stores) {
      this.seen.add(event.eventId);
    }
    const work = this.chain.then(async () => {
      const payload = await storeInlineBlobs(event.data, this.ctx.artifacts);
      const message: Message & {
        type: 'event';
      } = {
        type: 'event',
        event: {
          id: event.eventId,
          type: event.name,
          time: event.timestamp,
          payload,
          cursor: event.cursor ?? null,
          ...(event.actionId === undefined
            ? {}
            : {
                actionId: event.actionId,
              }),
        },
      };
      if (!this.req.stores) {
        this.queue.push(message);
        this.place = event.cursor ?? this.place;
        return;
      }
      const signal = this.controller.signal;
      await this.stored(message, signal);
      this.place = event.cursor ?? this.place;
    });
    this.chain = work.catch((error: unknown) => this.fail(error));
    return work;
  }

  /** Hands the listener an event and waits to hear it is stored. */
  private stored(
    message: Message & {
      type: 'event';
    },
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const abort = (): void =>
        reject(new Error('Event stream closed before storage acknowledged the event'));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, {
        once: true,
      });
      this.queue.push({
        ...message,
        stored: (error) => {
          signal.removeEventListener('abort', abort);
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        },
      });
    });
  }

  private async startPush(): Promise<void> {
    const { session } = this.ctx;
    let id: string | number | undefined;
    let heartbeatMs: number | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    /** Any message shows the stream is alive. */
    const beat = (): void => {
      clearTimeout(watchdog);
      if (heartbeatMs !== undefined) {
        watchdog = setTimeout(
          () => this.fail(new Error('the event stream went quiet')),
          heartbeatMs * MISSED_HEARTBEATS,
        );
      }
    };
    const on = <
      S extends z.ZodType<{
        _meta: Record<string, unknown>;
      }>,
    >(
      method: string,
      schema: S,
      take: (params: z.output<S>) => void,
    ): (() => void) =>
      session.on(method, (params) => {
        const parsed = schema.safeParse(params);
        if (!parsed.success || parsed.data._meta[SUBSCRIPTION_META] !== id) {
          return;
        }
        take(parsed.data);
        beat();
      });
    const offs = [
      on(McpNotification.EventsActive, StreamActiveParamsSchema, (params) => {
        heartbeatMs = params.heartbeatMs ?? heartbeatMs;
        this.confirm(params.cursor);
        this.grant(params.cursor, params.truncated);
      }),
      on(McpNotification.EventsEvent, StreamEventParamsSchema, (params) => {
        void this.enqueueEvent(params).catch(() => {});
      }),
      on(McpNotification.EventsHeartbeat, StreamHeartbeatParamsSchema, (params) =>
        this.commit(params.cursor),
      ),
      // A passing fault: the stream stays open.
      on(McpNotification.EventsError, StreamErrorParamsSchema, () => {}),
      on(McpNotification.EventsTerminated, StreamErrorParamsSchema, (params) =>
        this.enqueue(async () => this.terminate(ended(params.error))),
      ),
    ];
    this.cleanups.push(() => {
      clearTimeout(watchdog);
      for (const off of offs) {
        off();
      }
    });
    const stream = session.stream(
      McpMethod.EventsStream,
      {
        ...this.baseParams(),
        cursor: this.req.cursor ?? null,
      },
      this.controller.signal,
    );
    id = stream.id;
    this.watchSession();
    await stream.done;
    this.enqueue(async () => this.terminate('the server closed the event stream'));
  }

  private async startWebhook(): Promise<void> {
    const webhooks = this.ctx.webhooks;
    if (webhooks === undefined) {
      throw new Error('no webhook receiver');
    }
    const secret = generateWebhookSecret();
    const seen = new BoundedSet();
    const registration: WebhookRegistration = await webhooks.receiver.register(
      (delivery: WebhookDelivery): Promise<WebhookReply> =>
        this.receiveWebhook(delivery, {
          secret,
          seen,
          toleranceSec: webhooks.toleranceSec,
        }),
    );
    if (this.closed) {
      await registration.close();
      return;
    }
    this.cleanups.push(() => registration.close());
    const delivery = {
      mode: 'webhook',
      url: registration.url,
      secret,
    };
    const subscribe = async (
      params: Record<string, unknown>,
    ): Promise<z.infer<typeof SubscribeResultSchema>> => {
      const result = await this.ctx.session.request(
        McpMethod.EventsSubscribe,
        {
          ...this.baseParams(),
          ...params,
          delivery,
        },
        SubscribeResultSchema,
        {
          signal: this.controller.signal,
        },
      );
      this.subscriptionId = result.id;
      return result;
    };
    const granted = await subscribe({
      cursor: this.req.cursor ?? null,
    });
    if (this.closed) {
      await this.unsubscribe(registration.url);
      return;
    }
    this.cleanups.unshift(() => this.unsubscribe(registration.url));
    this.grant(granted.cursor, granted.truncated);
    // Worked out before the stream is confirmed: a time that makes no sense
    // refuses the subscription, and the listener backs off before trying again.
    let delay = refreshDelay(granted.refreshBefore, Date.now());
    this.confirm(granted.cursor);
    this.watchSession();
    // A subscription lapses unless it is made again in time. Each one names how far
    // this side has read, so a server that lost the subscription picks up from there.
    // The answer says how far the server has read: with no heartbeat, it is the only
    // way a quiet subscription's place moves.
    while (delay !== undefined) {
      await pause(delay, this.controller.signal);
      const again = await subscribe({
        cursor: this.place,
      });
      if (again.truncated) {
        this.gap();
      }
      this.commit(again.cursor);
      delay = refreshDelay(again.refreshBefore, Date.now());
    }
  }

  private async unsubscribe(url: string): Promise<void> {
    await this.ctx.session.request(
      McpMethod.EventsUnsubscribe,
      {
        ...this.baseParams(),
        delivery: {
          url,
        },
      },
      EmptyResultSchema,
      {
        timeoutMs: UNSUBSCRIBE_TIMEOUT_MS,
      },
    );
  }

  private async receiveWebhook(
    delivery: WebhookDelivery,
    opts: {
      secret: string;
      seen: SeenIds;
      toleranceSec: number | undefined;
    },
  ): Promise<WebhookReply> {
    const verified = await verifyWebhook({
      secret: opts.secret,
      delivery,
      nowSec: (this.ctx.nowSec ?? defaultNowSec)(),
      ...(opts.toleranceSec === undefined
        ? {}
        : {
            toleranceSec: opts.toleranceSec,
          }),
    });
    if (!verified.ok) {
      return {
        status: 401,
      };
    }
    // A delivery counts as taken only once it is: one answered 503 comes again
    // under the same id. A trigger stores each event and says so, so its sender
    // may deliver one again and nothing is dropped here.
    const again = (): boolean => {
      if (this.req.stores) {
        return false;
      }
      const known = opts.seen.has(verified.id);
      opts.seen.add(verified.id);
      return known;
    };
    const body = parseJson(delivery.body);
    const control = WebhookControlSchema.safeParse(body);
    if (control.success) {
      return control.data.type !== 'verification' && again()
        ? {
            status: 200,
          }
        : this.receiveControl(control.data);
    }
    const event = WireEventSchema.safeParse(body);
    const subscription = delivery.headers[SUBSCRIPTION_HEADER];
    if (!event.success || event.data.name !== this.req.event) {
      return {
        status: 400,
      };
    }
    // The server may deliver before it has answered `events/subscribe` with the id.
    if (this.closed || this.subscriptionId === undefined) {
      return {
        status: 503,
      };
    }
    if (subscription !== undefined && subscription !== this.subscriptionId) {
      return {
        status: 400,
      };
    }
    if (again()) {
      return {
        status: 200,
      };
    }
    const stored = this.enqueueEvent(event.data);
    if (!this.req.stores) {
      stored.catch(() => {});
      return {
        status: 204,
      };
    }
    try {
      await stored;
    } catch {
      return {
        status: 503,
      };
    }
    return {
      status: 204,
    };
  }

  private receiveControl(message: z.infer<typeof WebhookControlSchema>): WebhookReply {
    if (message.type === 'verification') {
      // The server delivers nothing until the endpoint proves it wants the events.
      return {
        status: 200,
        body: JSON.stringify({
          challenge: message.challenge,
        }),
      };
    }
    if (message.type === 'gap') {
      this.gap();
      this.commit(message.cursor);
    } else {
      this.enqueue(async () => this.terminate(ended(message.error)));
    }
    return {
      status: 204,
    };
  }

  private async startPoll(): Promise<void> {
    let cursor: string | null = this.req.cursor ?? null;
    let first = true;
    while (!this.closed) {
      // A subscription the server ended answers with an error, which ends the stream.
      const result = await this.ctx.session.request(
        McpMethod.EventsPoll,
        {
          ...this.baseParams(),
          cursor,
        },
        PollResultSchema,
        {
          signal: this.controller.signal,
        },
      );
      const next = result.cursor ?? null;
      if (first) {
        first = false;
        // `ready` is where listening starts: before this batch's events when it
        // has any, so a resume from it delivers them again rather than skipping them.
        this.confirm(result.events.length > 0 ? cursor : (next ?? cursor));
      }
      if (result.truncated) {
        this.gap();
      }
      const last = result.events.at(-1);
      for (const event of result.events) {
        // A page has one cursor, for all of it. A trigger takes it once the whole
        // page is stored; any other listener gets it on the page's last event.
        await this.enqueueEvent({
          ...event,
          cursor: this.req.checkpoint || event !== last ? null : next,
        });
      }
      if (next !== null && next !== cursor) {
        await this.req.checkpoint?.(next);
      }
      cursor = next ?? cursor;
      if (!result.hasMore) {
        await pause(
          Math.max(result.nextPollMs ?? 0, this.ctx.pollIntervalMs),
          this.controller.signal,
        );
      }
    }
  }

  private watchSession(): void {
    void this.ctx.session.closed.then(({ reason }) => {
      if (!this.closed) {
        this.enqueue(async () => this.terminate(reason));
      }
    });
  }
}

function defaultNowSec(): number {
  return Math.floor(Date.now() / 1e3);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

//#endregion

//#region Public API

/** @public A stream that ends at once with a `terminated` message (an event the connection does not offer). */
export function terminatedEventStream(reason: string): EventStream {
  const queue = new MessageQueue();
  queue.push({
    type: 'terminated',
    reason,
  });
  queue.end();
  const ready = Promise.reject(new Error(reason));
  ready.catch(() => {});
  return {
    ready,
    close: async (): Promise<void> => {},
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  };
}

/** @public Opens an event stream for one event type. */
export function openEventStream(ctx: EventContext, req: ListenRequest): EventStream {
  const stream = new McpEventStream(ctx, req);
  if (!req.signal.aborted) {
    stream.start();
  }
  return stream;
}

//#endregion
