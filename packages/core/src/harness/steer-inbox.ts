import type {
  AgentHarnessContract,
  Context,
  ContextLayer,
  DeliveryMode,
  FunctionCallItem,
  Item,
  SteerVerdict,
} from '@noetic-tools/types';
import { frameworkCast, SteerAction, SteerPoint } from '@noetic-tools/types';
import type { MessageQueue, QueuedMessage, SessionCtxExtension } from '../runtime/message-queue';
import { inputToItems, isSteer } from '../runtime/message-queue';

//#region Types

/** @internal Steers taken off the queue, waiting for the next model call. */
export interface StagedSteers {
  messageIds: string[];
  items: Item[];
}

interface SteerInboxOpts {
  queue: MessageQueue;
  ctx: Context;
  layers: ContextLayer[];
  harness: AgentHarnessContract;
  emit: (eventType: string, data: Record<string, unknown>) => void;
}

//#endregion

//#region Public API

/**
 * @internal Open the steer inbox for a model call, or `undefined` when the call
 * runs outside a session. A context inherits its parent's session only when it
 * was spawned with `steers: 'forward'`; parallel paths and other spawns hold
 * steers until control returns to the session's own context.
 */
export function openSteerInbox(
  opts: Omit<SteerInboxOpts, 'queue' | 'ctx'> & {
    ctx: Context | undefined;
  },
): SteerInbox | undefined {
  const { ctx } = opts;
  if (!ctx) {
    return undefined;
  }
  const queue = findSessionQueue(ctx);
  if (!queue) {
    return undefined;
  }
  return new SteerInbox({
    ...opts,
    ctx,
    queue,
  });
}

/**
 * @internal The steers a running model call can take. The call offers queued
 * steers to the context layers at each steer point; those the layers apply are
 * staged and handed over before the next model call.
 */
export class SteerInbox {
  private staged: StagedSteers = {
    messageIds: [],
    items: [],
  };
  /** Steers already reported as waiting on tool calls, so each is reported once. */
  private readonly reportedPending = new Set<string>();

  constructor(private readonly opts: SteerInboxOpts) {}

  hasQueued(): boolean {
    return this.opts.queue.peekAll().some(isSteer);
  }

  hasStaged(): boolean {
    return this.staged.messageIds.length > 0;
  }

  /**
   * Offer every queued steer at `point`. Returns `true` when at least one was
   * staged by this offer.
   */
  async offer(
    point: SteerPoint,
    pendingCalls: ReadonlyArray<FunctionCallItem> = [],
  ): Promise<boolean> {
    let stagedAny = false;
    for (const message of this.opts.queue.peekAll().filter(isSteer)) {
      const verdict = await this.judge(message, point, pendingCalls);
      if (verdict.action === SteerAction.Defer) {
        this.reportPending(message, point, pendingCalls);
        continue;
      }
      // A sibling call may have taken it while the layers were judging.
      if (this.opts.queue.take((queued) => queued === message).length === 0) {
        continue;
      }
      if (verdict.action === SteerAction.Drop) {
        this.opts.emit('steer_dropped', {
          messageId: message.id,
          point,
        });
        continue;
      }
      await this.stage(message.id, verdict.items);
      stagedAny = true;
    }
    return stagedAny;
  }

  /** Hand over the staged steers and clear them. */
  takeStaged(): StagedSteers {
    const staged = this.staged;
    this.staged = {
      messageIds: [],
      items: [],
    };
    return staged;
  }

  private async judge(
    message: QueuedMessage,
    point: SteerPoint,
    pendingCalls: ReadonlyArray<FunctionCallItem>,
  ): Promise<SteerVerdict> {
    const action = defaultAction(point, message.deliveryMode);
    const items = inputToItems(message.input);
    const { harness, layers } = this.opts;
    if (!harness.onSteer || !layers.some((layer) => layer.hooks.onSteer)) {
      return {
        action,
        items,
      };
    }
    return harness.onSteer(
      layers,
      {
        steer: {
          id: message.id,
          items,
        },
        point,
        action,
        pendingCalls,
      },
      this.opts.ctx,
    );
  }

  /** Steers are user input, so they pass through `onItemAppend` like any other.
   *  Re-render requests are ignored: recall does not run again mid-call. */
  private async stage(messageId: string, items: Item[]): Promise<void> {
    const piped =
      this.opts.layers.length > 0
        ? (await this.opts.harness.runAppendPipeline(this.opts.layers, items, this.opts.ctx)).items
        : items;
    this.staged.messageIds.push(messageId);
    this.staged.items.push(...piped);
  }

  private reportPending(
    message: QueuedMessage,
    point: SteerPoint,
    pendingCalls: ReadonlyArray<FunctionCallItem>,
  ): void {
    if (point !== SteerPoint.BeforeToolCall || this.reportedPending.has(message.id)) {
      return;
    }
    this.reportedPending.add(message.id);
    this.opts.emit('steer_pending', {
      messageId: message.id,
      waitingOn: pendingCalls.map((call) => call.callId),
    });
  }
}

//#endregion

//#region Helpers

function findSessionQueue(ctx: Context): MessageQueue | undefined {
  for (let current: Context | null = ctx; current; current = current.parent) {
    const ext = frameworkCast<Context & SessionCtxExtension>(current);
    if (ext._sessionQueue) {
      return ext._sessionQueue;
    }
    if (!ext._forwardSteers) {
      return undefined;
    }
  }
  return undefined;
}

/** What each delivery mode does at each point before any layer has a say. */
function defaultAction(point: SteerPoint, mode: DeliveryMode): SteerAction {
  if (point === SteerPoint.BeforeRound) {
    return SteerAction.Apply;
  }
  if (point === SteerPoint.ItemDone && mode === 'next-item') {
    return SteerAction.Apply;
  }
  return SteerAction.Defer;
}

//#endregion
