/**
 * Paid dispatches: a record before every paid provider call, and the bill settled
 * afterwards even when the call was cut off (spec 23 § Paid dispatches).
 *
 * A call's record is written before it is sent, gains the provider's generation id
 * when its response headers arrive, and is deleted when its bill reaches the run.
 * A call that ends any other way — cancelled, steered, timed out, its host killed —
 * leaves the record behind. It is then *pending*: held at its ceiling, and priced
 * through the provider's generation lookup once the provider has billed it.
 */

import type {
  Context,
  PendingSpend,
  ReconcileSpendOptions,
  SpendKind,
  SpendSettlement,
  UsageCharge,
  WriteOffSpendOptions,
} from '@noetic-tools/types';
import { estimateTokens, recordUsage } from '@noetic-tools/types';
import type { OpenRouter } from '@openrouter/sdk';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import type { DispatchRecord, SpendLog } from '../runtime/durable/spend-log';
import { hashStepInput } from '../runtime/durable/step-ledger';
import { statusOf } from '../util/status-code';
import type { EventBroadcaster } from './deps/runtime';
import { ContextImpl, laneBase } from './deps/runtime';
import type { ModelPrice } from './model-price';
import { ceilingOf, createPriceBook, LOOKUP_TIMEOUT_MS } from './model-price';
import { roundPath } from './model-rounds';

//#region Types

/** @internal Request header that ties a response back to its dispatch. */
export const DISPATCH_HEADER = 'x-noetic-dispatch';

/** @internal Response header carrying OpenRouter's id for the call. */
export const GENERATION_HEADER = 'x-generation-id';

const DEFAULT_PATIENCE_MS = 60e3;
const FIRST_POLL_MS = 1e3;
const MAX_POLL_MS = 10e3;

/** @internal The slice of the SDK client spend needs: prices and generation lookups. */
export type SpendClient = Pick<OpenRouter, 'models' | 'generations'>;

/** @internal What the harness gives `Spend`. */
export interface SpendHost {
  readonly agentName: string;
  readonly log: SpendLog;
  client(): SpendClient | undefined;
  /** The root context with a run in flight under `executionId`, if any. */
  liveRoot(executionId: string): Context | undefined;
  /** Add `charge` to the thread's stored session. False when the thread has none. */
  chargeSession(threadId: string, charge: UsageCharge): Promise<boolean>;
  sessionBroadcaster(threadId: string): EventBroadcaster | undefined;
}

/** @internal One paid call about to be sent. */
export interface DispatchParams {
  ctx?: Context;
  kind: SpendKind;
  model: string;
  /** The request body, hashed and sized for the record. */
  body: unknown;
  maxOutputTokens?: number;
  /** The model-loop round, for a `callModel` round's ledger key. */
  round?: number;
}

/** A pending dispatch this harness holds. */
interface Hold {
  record: DispatchRecord;
  /** The root context its ceiling is held on. */
  ctx?: ContextImpl;
  ceiling?: number;
  /** Settles once the ceiling is known and held. */
  ready: Promise<void>;
}

interface Bill {
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

//#endregion

//#region Spend

/**
 * @internal
 * One harness's paid dispatches: the live ones it is sending and the pending ones it
 * holds. Pending records come from storage, so any harness over the same storage can
 * settle a call another harness made.
 */
export class Spend {
  private readonly live = new Map<string, Dispatch>();
  private readonly holds = new Map<string, Hold>();
  /**
   * Generation lookups in flight, so two callers never settle one dispatch twice and
   * a reconcile waits for the ones already running.
   */
  private readonly lookups = new Map<
    string,
    {
      executionId?: string;
      settled: Promise<SpendSettlement | undefined>;
    }
  >();
  private readonly price: (model: string) => Promise<ModelPrice | undefined>;

  constructor(private readonly host: SpendHost) {
    this.price = createPriceBook(() => host.client());
  }

  /** Write the record for a call about to be sent. A failed write never blocks the call. */
  async open(params: DispatchParams): Promise<Dispatch> {
    const root = rootOf(params.ctx);
    const path = pathOf(params.ctx);
    const record: DispatchRecord = {
      id: crypto.randomUUID(),
      kind: params.kind,
      model: params.model,
      requestHash: hashStepInput(params.body) ?? '',
      inputTokens: estimateTokens(JSON.stringify(params.body) ?? ''),
      ...(params.maxOutputTokens !== undefined
        ? {
            maxOutputTokens: params.maxOutputTokens,
          }
        : {}),
      ...(root
        ? {
            executionId: root.id,
            threadId: root.threadId,
          }
        : {}),
      ...(path !== undefined
        ? {
            path: params.round === undefined ? path : roundPath(path, params.round),
          }
        : {}),
      sentAt: new Date().toISOString(),
    };
    const dispatch = new Dispatch(this, this.host.log, record, root);
    this.live.set(record.id, dispatch);
    await quietly('write', () => this.host.log.put(record));
    return dispatch;
  }

  /** Save a live dispatch's generation id. The client's response hook awaits it. */
  noteGeneration(dispatchId: string, generationId: string): Promise<void> {
    return this.live.get(dispatchId)?.noteGeneration(generationId) ?? Promise.resolve();
  }

  /** Unsettled dispatches, each with its ceiling. */
  async pending(executionId?: string): Promise<PendingSpend[]> {
    const records = await this.unsettled(executionId);
    return Promise.all(
      records.map(async (record) => {
        const ceiling = await this.ceilingOf(record);
        return ceiling === undefined
          ? record
          : {
              ...record,
              ceiling,
            };
      }),
    );
  }

  /**
   * Hold the restored root context's pending dispatches on it, then reconcile them in
   * the background. `ctx.heldCost` is set when this resolves.
   */
  async adopt(ctx: Context): Promise<void> {
    const root = rootOf(ctx);
    const records = await this.unsettled(ctx.id);
    await Promise.all(records.map((record) => this.hold(record, root)));
    void this.reconcile({
      executionId: ctx.id,
    });
  }

  /**
   * Price every pending dispatch that has a generation id, polling until the provider
   * has, and wait for lookups already running for the same dispatches.
   */
  async reconcile(opts: ReconcileSpendOptions = {}): Promise<SpendSettlement[]> {
    const { executionId } = opts;
    const running = [
      ...this.lookups.values(),
    ]
      .filter((lookup) => executionId === undefined || lookup.executionId === executionId)
      .map((lookup) => lookup.settled);
    const records = await this.unsettled(executionId);
    await Promise.all(records.map((record) => this.hold(record)));
    const patienceMs = opts.patienceMs ?? DEFAULT_PATIENCE_MS;
    const settled = await Promise.all([
      ...running,
      ...records.map((record) => this.lookup(record, patienceMs)),
    ]);
    const unique = new Map<string, SpendSettlement>();
    for (const settlement of settled) {
      if (settlement) {
        unique.set(settlement.id, settlement);
      }
    }
    return [
      ...unique.values(),
    ];
  }

  /** Settle one pending dispatch at an amount the host asserts. */
  async writeOff(id: string, opts: WriteOffSpendOptions): Promise<SpendSettlement | undefined> {
    if (this.live.has(id)) {
      return undefined;
    }
    const record = this.holds.get(id)?.record ?? (await this.host.log.get(id));
    if (!record) {
      return undefined;
    }
    await this.hold(record);
    return this.settle(
      id,
      {
        cost: opts.assumedCost,
        inputTokens: 0,
        outputTokens: 0,
      },
      true,
    );
  }

  /** USD held for a thread's pending dispatches. */
  heldFor(threadId: string): number {
    let held = 0;
    for (const hold of this.holds.values()) {
      if (hold.record.threadId === threadId) {
        held += hold.ceiling ?? 0;
      }
    }
    return held;
  }

  /** A live dispatch ended. Called by `Dispatch` only. */
  release(id: string): void {
    this.live.delete(id);
  }

  /** A dispatch ended without a bill: hold it and start looking for one. Called by `Dispatch` only. */
  leave(record: DispatchRecord, root: ContextImpl | undefined): void {
    void this.hold(record, root)
      .then(() => this.lookup(record, DEFAULT_PATIENCE_MS))
      .catch((error: unknown) => warn('reconcile', error));
  }

  private async unsettled(executionId: string | undefined): Promise<DispatchRecord[]> {
    const records = await this.host.log.list();
    return records.filter(
      (record) =>
        !this.live.has(record.id) &&
        (executionId === undefined || record.executionId === executionId),
    );
  }

  /**
   * Hold `record` at its ceiling, on `ctx` when given. A dispatch already held without
   * a context gains this one.
   */
  private hold(record: DispatchRecord, ctx?: ContextImpl): Promise<void> {
    const known = this.holds.get(record.id);
    if (known) {
      if (ctx && !known.ctx) {
        known.ctx = ctx;
        ctx.heldCost += known.ceiling ?? 0;
      }
      return known.ready;
    }
    const hold: Hold = {
      record,
      ctx,
      ready: Promise.resolve(),
    };
    this.holds.set(record.id, hold);
    hold.ready = this.ceilingOf(record).then((ceiling) => {
      if (this.holds.get(record.id) !== hold) {
        return;
      }
      hold.ceiling = ceiling;
      if (hold.ctx && ceiling !== undefined) {
        hold.ctx.heldCost += ceiling;
      }
      this.emit(hold, 'spend_pending', {
        id: record.id,
        kind: record.kind,
        model: record.model,
        generationId: record.generationId,
        ceiling,
        ...(ceiling === undefined
          ? {
              unbounded: true,
            }
          : {}),
      });
    });
    return hold.ready;
  }

  private async ceilingOf(record: DispatchRecord): Promise<number | undefined> {
    const price = await this.price(record.model);
    return price ? ceilingOf(record, price) : undefined;
  }

  private lookup(record: DispatchRecord, patienceMs: number): Promise<SpendSettlement | undefined> {
    const generationId = record.generationId;
    if (!generationId) {
      return Promise.resolve(undefined);
    }
    const running = this.lookups.get(record.id);
    if (running) {
      return running.settled;
    }
    const settled = this.poll(record.id, generationId, patienceMs).finally(() => {
      this.lookups.delete(record.id);
    });
    this.lookups.set(record.id, {
      executionId: record.executionId,
      settled,
    });
    return settled;
  }

  /**
   * Ask the provider for the call's bill until it has one. The provider prices a call
   * some seconds after it ends — 7 to 32 s observed — so a lookup that gave up after a
   * few seconds would leave ordinary calls unknown.
   */
  private async poll(
    id: string,
    generationId: string,
    patienceMs: number,
  ): Promise<SpendSettlement | undefined> {
    const client = this.host.client();
    if (!client) {
      return undefined;
    }
    const deadline = Date.now() + patienceMs;
    for (let wait = FIRST_POLL_MS; this.holds.has(id); wait = Math.min(wait * 2, MAX_POLL_MS)) {
      const bill = await fetchBill(client, generationId);
      if (bill === 'stop') {
        return undefined;
      }
      if (bill) {
        return this.settle(id, bill);
      }
      if (Date.now() + wait > deadline) {
        return undefined;
      }
      await sleep(wait);
    }
    return undefined;
  }

  /**
   * Settle a held dispatch: drop its record, release its hold, and charge its bill
   * once. The record goes first, so a crash part-way loses a settlement rather than
   * counting one twice.
   */
  private async settle(
    id: string,
    bill: Bill,
    writtenOff = false,
  ): Promise<SpendSettlement | undefined> {
    const hold = this.holds.get(id);
    if (!hold) {
      return undefined;
    }
    this.holds.delete(id);
    if (hold.ctx && hold.ceiling !== undefined) {
      hold.ctx.heldCost = Math.max(0, hold.ctx.heldCost - hold.ceiling);
    }
    await quietly('delete', () => this.host.log.remove(id));
    await this.charge(hold, bill);
    const { executionId, threadId } = hold.record;
    this.emit(hold, 'spend_settled', {
      id,
      cost: bill.cost,
      ...(writtenOff
        ? {
            writtenOff,
          }
        : {}),
    });
    return {
      id,
      ...(executionId !== undefined
        ? {
            executionId,
          }
        : {}),
      ...(threadId !== undefined
        ? {
            threadId,
          }
        : {}),
      ...bill,
      ...(writtenOff
        ? {
            writtenOff: true as const,
          }
        : {}),
    };
  }

  /**
   * Charge a bill to one place: the run in flight on its execution, else its thread's
   * session, else the context this harness held it on. A run in flight passes the
   * charge on to its turn's usage, so charging the session too would count it twice.
   */
  private async charge(hold: Hold, bill: Bill): Promise<void> {
    const charge: UsageCharge = {
      inputTokens: bill.inputTokens,
      outputTokens: bill.outputTokens,
      cost: bill.cost,
      billedCost: bill.cost,
    };
    const { executionId, threadId } = hold.record;
    const live = executionId !== undefined ? this.host.liveRoot(executionId) : undefined;
    if (live) {
      recordUsage(live, charge);
      return;
    }
    if (threadId !== undefined && (await this.host.chargeSession(threadId, charge))) {
      return;
    }
    if (hold.ctx) {
      recordUsage(hold.ctx, charge);
    }
  }

  private emit(hold: Hold, eventType: string, data: Record<string, unknown>): void {
    const threadId = hold.record.threadId;
    emitFrameworkEvent({
      broadcaster:
        getBroadcaster(hold.ctx) ??
        (threadId !== undefined ? this.host.sessionBroadcaster(threadId) : undefined),
      agentName: this.host.agentName,
      eventType,
      data,
    });
  }
}

//#endregion

//#region Dispatch

/**
 * @internal
 * One paid call in flight. Record writes run one at a time, so a generation id saved
 * late never brings back a record that was already deleted.
 */
export class Dispatch {
  private writes: Promise<void> = Promise.resolve();
  private ended = false;

  constructor(
    private readonly spend: Spend,
    private readonly log: SpendLog,
    readonly record: DispatchRecord,
    private readonly root: ContextImpl | undefined,
  ) {}

  /** Request headers that tie the response back to this dispatch. */
  get headers(): Record<string, string> {
    return {
      [DISPATCH_HEADER]: this.record.id,
    };
  }

  noteGeneration(generationId: string): Promise<void> {
    if (this.ended || this.record.generationId) {
      return this.writes;
    }
    this.record.generationId = generationId;
    return this.queue('write', () => this.log.put(this.record));
  }

  /** The call's bill reached the run, or the provider refused it: drop the record. */
  settle(): Promise<void> {
    if (this.ended) {
      return this.writes;
    }
    this.ended = true;
    this.spend.release(this.record.id);
    return this.queue('delete', () => this.log.remove(this.record.id));
  }

  /** The call is over. Without a settled bill its record stays, pending. */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.spend.release(this.record.id);
    void this.writes.then(() => this.spend.leave(this.record, this.root));
  }

  private queue(what: string, write: () => Promise<void>): Promise<void> {
    this.writes = this.writes.then(() => quietly(what, write));
    return this.writes;
  }
}

//#endregion

//#region Helpers

function rootOf(ctx: Context | undefined): ContextImpl | undefined {
  let node = ctx;
  while (node?.parent) {
    node = node.parent;
  }
  const root = node ? laneBase(node) : undefined;
  return root instanceof ContextImpl ? root : undefined;
}

function pathOf(ctx: Context | undefined): string | undefined {
  return ctx instanceof ContextImpl ? ctx.currentDispatch()?.path : undefined;
}

/**
 * The provider's bill for a call: undefined while it has not priced it yet, 'stop'
 * when asking again cannot help.
 */
async function fetchBill(
  client: SpendClient,
  generationId: string,
): Promise<Bill | 'stop' | undefined> {
  try {
    const { data } = await client.generations.getGeneration(
      {
        id: generationId,
      },
      {
        timeoutMs: LOOKUP_TIMEOUT_MS,
      },
    );
    return {
      cost: data.totalCost,
      inputTokens: data.tokensPrompt ?? 0,
      outputTokens: data.tokensCompletion ?? 0,
    };
  } catch (e) {
    const status = statusOf(e);
    const transient = status === undefined || status === 404 || status === 429 || status >= 500;
    return transient ? undefined : 'stop';
  }
}

/** Storage is best-effort here, as for checkpoints: a failed write never fails the call. */
async function quietly(what: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    warn(what, error);
  }
}

function warn(what: string, error: unknown): void {
  console.warn(
    `Spend: dispatch ${what} failed:`,
    error instanceof Error ? error.message : String(error),
  );
}

/** A wait that does not keep the host process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }
  });
}

//#endregion
