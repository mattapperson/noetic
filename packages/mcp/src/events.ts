/**
 * Listening over the Events extension (SEP-3415). A stream prefers push
 * (`events/stream` + notifications), then webhook (`events/subscribe`, when
 * the bridge has a receiver), then poll (`events/poll`), by what the server
 * offers; callers never see the difference. Events are deduplicated by id
 * within a stream, webhook deliveries are verified (Standard Webhooks
 * signature, timestamp window, duplicate delivery ids dropped), and `gap` and
 * `terminated` control messages are passed through.
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
import type { EventDelivery, WireEvent } from './wire';
import {
  EmptyResultSchema,
  EVENTS_EXTENSION,
  EventsCapabilitySchema,
  McpMethod,
  McpNotification,
  PollResultSchema,
  PushEventParamsSchema,
  PushGapParamsSchema,
  PushTerminatedParamsSchema,
  SubscriptionResultSchema,
  WebhookBodySchema,
} from './wire';

//#region Types

/** @public What a stream needs from its connection. */
export interface EventContext {
  readonly session: McpSession;
  readonly artifacts: ArtifactStore;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly pollIntervalMs: number;
  readonly webhooks?: McpWebhooks;
  /** Seconds since the epoch; overridable for tests. */
  readonly nowSec?: () => number;
}

type Message = EventStreamMessage<ConnectionEventInit>;

type ControlMessage = z.infer<typeof WebhookBodySchema>;

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

/** @public The delivery modes the server offers, in the bridge's preference order. */
export function deliveryModes(
  session: McpSession,
  webhooks: McpWebhooks | undefined,
): EventDelivery[] {
  const parsed = EventsCapabilitySchema.safeParse(session.extension(EVENTS_EXTENSION));
  const offered: ReadonlyArray<EventDelivery> = parsed.success
    ? (parsed.data.delivery ?? [
        'push',
        'poll',
      ])
    : [];
  const preference: ReadonlyArray<EventDelivery> = [
    'push',
    'webhook',
    'poll',
  ];
  return preference.filter(
    (mode) => offered.includes(mode) && (mode !== 'webhook' || webhooks !== undefined),
  );
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
  private subscriptionId: string | undefined;
  private readonly early: ControlMessage[] = [];
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly ctx: EventContext,
    private readonly req: ListenRequest,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.settleReady = resolve;
      this.failReady = reject;
    });
    this.ready.catch(() => {});
    if (req.signal.aborted) {
      void this.close();
      return;
    }
    req.signal.addEventListener('abort', () => void this.close(), {
      once: true,
    });
  }

  start(): void {
    const [mode] = deliveryModes(this.ctx.session, this.ctx.webhooks);
    const run =
      mode === 'push'
        ? this.startPush()
        : mode === 'webhook'
          ? this.startWebhook()
          : mode === 'poll'
            ? this.startPoll()
            : Promise.reject(new Error('the server offers no event delivery this bridge can use'));
    run.catch((error: unknown) => this.fail(error));
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

  private confirm(subscriptionId: string | undefined, cursor: string | null | undefined): void {
    this.subscriptionId = subscriptionId;
    this.settleReady({
      cursor: cursor ?? null,
    });
    for (const message of this.early.splice(0)) {
      this.route(message);
    }
  }

  /** Routes a control message for this subscription, buffering until the subscription id is known. */
  private route(message: ControlMessage): void {
    if (this.subscriptionId === undefined) {
      this.early.push(message);
      return;
    }
    if (message.subscriptionId !== this.subscriptionId) {
      return;
    }
    if (message.type === 'event') {
      this.enqueueEvent(message);
      return;
    }
    if (message.type === 'gap') {
      this.enqueue(async () => {
        this.queue.push({
          type: 'gap',
          reason: message.reason,
          ...(message.from === undefined
            ? {}
            : {
                from: message.from,
              }),
          ...(message.to === undefined
            ? {}
            : {
                to: message.to,
              }),
        });
      });
      return;
    }
    this.enqueue(async () => this.terminate(message.reason));
  }

  /** Runs `work` after everything queued before it, keeping delivery in order. */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error: unknown) => this.fail(error));
  }

  private enqueueEvent(event: WireEvent): void {
    if (event.name !== this.req.event || this.seen.has(event.eventId)) {
      return;
    }
    this.seen.add(event.eventId);
    this.enqueue(async () => {
      const payload = await storeInlineBlobs(event.data, this.ctx.artifacts);
      this.queue.push({
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
      });
    });
  }

  private async unsubscribe(): Promise<void> {
    if (this.subscriptionId === undefined) {
      return;
    }
    await this.ctx.session.request(
      McpMethod.EventsUnsubscribe,
      {
        subscriptionId: this.subscriptionId,
        _meta: this.ctx.meta,
      },
      EmptyResultSchema,
    );
  }

  private async startPush(): Promise<void> {
    const { session } = this.ctx;
    const offs = [
      session.on(McpNotification.EventsEvent, (params) => {
        const parsed = PushEventParamsSchema.safeParse(params);
        if (parsed.success) {
          this.route({
            ...parsed.data,
            type: 'event',
          });
        }
      }),
      session.on(McpNotification.EventsGap, (params) => {
        const parsed = PushGapParamsSchema.safeParse(params);
        if (parsed.success) {
          this.route({
            ...parsed.data,
            type: 'gap',
          });
        }
      }),
      session.on(McpNotification.EventsTerminated, (params) => {
        const parsed = PushTerminatedParamsSchema.safeParse(params);
        if (parsed.success) {
          this.route({
            ...parsed.data,
            type: 'terminated',
          });
        }
      }),
    ];
    this.cleanups.push(() => {
      for (const off of offs) {
        off();
      }
    });
    const result = await session.request(
      McpMethod.EventsStream,
      {
        ...this.baseParams(),
        cursor: this.req.cursor ?? null,
      },
      SubscriptionResultSchema,
      {
        signal: this.controller.signal,
      },
    );
    this.cleanups.push(() => this.unsubscribe());
    this.confirm(result.subscriptionId, result.cursor);
    this.watchSession();
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
    this.cleanups.push(() => registration.close());
    const result = await this.ctx.session.request(
      McpMethod.EventsSubscribe,
      {
        ...this.baseParams(),
        cursor: this.req.cursor ?? null,
        delivery: {
          url: registration.url,
          secret,
        },
      },
      SubscriptionResultSchema,
      {
        signal: this.controller.signal,
      },
    );
    this.cleanups.unshift(() => this.unsubscribe());
    this.confirm(result.subscriptionId, result.cursor);
    this.watchSession();
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
      seen: opts.seen,
    });
    if (!verified.ok) {
      return {
        status: verified.reason === 'duplicate' ? 200 : 401,
      };
    }
    const parsed = WebhookBodySchema.safeParse(parseJson(delivery.body));
    if (!parsed.success) {
      return {
        status: 400,
      };
    }
    this.route(parsed.data);
    return {
      status: 204,
    };
  }

  private async startPoll(): Promise<void> {
    let cursor: string | null = this.req.cursor ?? null;
    let first = true;
    while (!this.closed) {
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
      if (first) {
        first = false;
        // `ready` is where listening starts: before this batch's events when it
        // has any, so a resume from it delivers them again rather than skipping them.
        this.confirm('poll', result.events.length > 0 ? cursor : (result.cursor ?? cursor));
      }
      if (result.gap !== undefined) {
        this.route({
          ...result.gap,
          subscriptionId: 'poll',
          type: 'gap',
        });
      }
      for (const event of result.events) {
        this.route({
          ...event,
          subscriptionId: 'poll',
          type: 'event',
        });
      }
      if (result.terminated !== undefined) {
        this.route({
          ...result.terminated,
          subscriptionId: 'poll',
          type: 'terminated',
        });
        return;
      }
      cursor = result.cursor ?? cursor;
      await pause(result.pollInterval ?? this.ctx.pollIntervalMs, this.controller.signal);
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
