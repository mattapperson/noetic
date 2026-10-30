/**
 * What `call` and `wait` steps share (spec 35 § Steps, § Durability; spec 23a
 * § Connection Steps): finding the harness registry, resolving the step's
 * connection through it, deriving idempotency keys, and the pending ledger
 * entries a resumed run picks up from.
 *
 * Steps never hold a provider's `Connection`: everything goes through the
 * registry contract in `connections/registry-types.ts`.
 */

import type {
  AnyProfile,
  ConnectionHandle,
  ConnectionIdentity,
  ConnectionRequirement,
  Context,
  Step,
  StepConnectionTarget,
  StorageAdapter,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, NoeticErrorImpl } from '@noetic-tools/types';
import { z } from 'zod';
import type { ResumeDecision } from '../connections/durability';
import { resumeDecision } from '../connections/durability';
import type {
  ConnectionRegistry,
  ConnectionScope,
  ResolvedConnection,
} from '../connections/registry-types';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import { ContextImpl } from '../runtime/context-impl';
import { harnessInternal } from '../util/harness-internals';
import { someStep } from './step-walk';

//#region Types

/** A step's connection after its target is evaluated. */
export interface ConnectionTargetInfo {
  /** The name the step uses: a handle's name, or a harness connection name. */
  name: string;
  handle?: ConnectionHandle;
}

/** What a step needs of its connection beyond its handle: the operation or event it uses. */
export interface StepUse {
  op?: string;
  event?: string;
}

/** A connection step's resolved connection plus the run facts it records against. */
export interface StepConnection {
  resolved: ResolvedConnection;
  scope: ConnectionScope;
  /** Run-and-step idempotency key, stable across a resume. */
  idempotencyKey: string;
  pending: PendingEntries | undefined;
}

/** A pending ledger entry: what a `call` or `wait` recorded before it reached a server. */
export type PendingEntry = z.infer<typeof PendingEntrySchema>;

//#endregion

//#region Constants

const PendingEntrySchema = z.object({
  stepId: z.string(),
  kind: z.enum([
    'call',
    'wait',
  ]),
  connection: z.string(),
  key: z.string(),
  identity: z.object({
    surface: z.string(),
    instance: z.string(),
    epoch: z.number().optional(),
  }),
  taskId: z.string().optional(),
  leaseId: z.string().optional(),
  cursor: z.string().nullish(),
  deadline: z.number().optional(),
});

//#endregion

//#region Context helpers

/** The harness surface connection steps read: its registry and its storage. */
interface HarnessWithConnections {
  connectionRegistry?: ConnectionRegistry;
  config?: {
    storage?: StorageAdapter;
  };
}

function harnessOf(ctx: Context): HarnessWithConnections {
  return {
    connectionRegistry: harnessInternal<ConnectionRegistry>(ctx.harness, 'connectionRegistry'),
    config: frameworkCast<Pick<HarnessWithConnections, 'config'>>(ctx.harness).config,
  };
}

/**
 * The harness's connection registry.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN` when the harness has no connections.
 */
export function connectionRegistryOf(ctx: Context, name: string): ConnectionRegistry {
  const registry = harnessOf(ctx).connectionRegistry;
  if (registry) {
    return registry;
  }
  throw new NoeticConfigError({
    code: 'CONNECTION_UNKNOWN',
    message: `Connection '${name}' is used, but the harness has no connections.`,
    hint: `Add it to the harness: new AgentHarness({ connections: { ${name}: mcp('…') } }).`,
  });
}

/** The topmost ancestor of `ctx`: the run's root context, whose id names the run. */
export function runRootOf(ctx: Context): Context {
  let current: Context = ctx;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

/** The abort signal of `ctx`, or one that never fires for a context without one (test stubs). */
export function signalOf(ctx: Context): AbortSignal {
  const signal = frameworkCast<{
    abortSignal?: AbortSignal;
  }>(ctx).abortSignal;
  return signal ?? new AbortController().signal;
}

/**
 * The lease scope of a resolution. `fresh: 'run'` scopes to the run; `fresh:
 * 'path'` to the parallel path the step runs on (the nearest context that is not
 * the run root — each `inParallel` path runs in its own child context).
 */
export function scopeFor(ctx: Context, fresh: 'run' | 'path' | undefined): ConnectionScope {
  const root = runRootOf(ctx);
  return {
    executionId: root.id,
    threadId: ctx.threadId,
    scopeKey: fresh === 'path' ? pathScopeKey(ctx) : root.id,
    signal: signalOf(ctx),
  };
}

/** The lease scope key of a `fresh: 'path'` connection drawn on `ctx`. */
export function pathScopeKey(ctx: Context): string {
  return `${runRootOf(ctx).id}:path:${ctx.id}`;
}

/**
 * Returns every `fresh: 'path'` lease the given parallel path contexts hold
 * (spec 35 § Fresh connections: "gives it back when the scope ends"). A no-op
 * when the harness has no connections.
 */
export async function releasePathLeases(paths: ReadonlyArray<Context>): Promise<void> {
  for (const path of paths) {
    const registry = harnessOf(path).connectionRegistry;
    if (!registry) {
      return;
    }
    await registry.releaseScope(pathScopeKey(path)).catch(() => undefined);
  }
}

/** The ledger path of the step running on `ctx`, when it runs on a lane. */
export function stepPathOf(ctx: Context): string | undefined {
  const path = ctx instanceof ContextImpl ? ctx.currentPath() : '';
  return path.length > 0 ? path : undefined;
}

/** The run-and-step key a call carries, stable across a resume of the same run (spec 35 § Durability). */
export function idempotencyKeyFor(ctx: Context, stepId: string, ledgerKey?: string): string {
  return `${runRootOf(ctx).id}:${ledgerKey ?? stepPathOf(ctx) ?? stepId}`;
}

//#endregion

//#region Target and requirement

function isHandle(value: unknown): value is ConnectionHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'connection-handle'
  );
}

/**
 * Evaluates a step's connection target.
 *
 * @throws `NoeticConfigError` `CONNECTION_INVALID` when it gives neither a handle nor a non-empty name.
 */
export async function evaluateTarget<TContext, I>(
  target: StepConnectionTarget<TContext, I>,
  input: I,
  ctx: Context<TContext>,
  stepId: string,
): Promise<ConnectionTargetInfo> {
  const value = typeof target === 'function' ? await target(input, ctx) : target;
  if (isHandle(value)) {
    return {
      name: value.name,
      handle: value,
    };
  }
  if (typeof value === 'string' && value.length > 0) {
    return {
      name: value,
    };
  }
  throw new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message: `Step '${stepId}' did not name a connection.`,
    hint: "Pass a handle from connection('name', profile) or a harness connection name.",
  });
}

function extensionsOf(handle: ConnectionHandle): Readonly<Record<string, string>> | undefined {
  const entries = handle.options.extensions ?? [];
  if (entries.length === 0) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.kind === 'extension-range') {
      out[entry.extension.id] = entry.range;
      continue;
    }
    out[entry.id] = entry.defaultRange;
  }
  return out;
}

/** What a handle (or a bare name) requires for one use: its profile and extensions, plus the op or event. */
export function requirementFor(target: ConnectionTargetInfo, use: StepUse): ConnectionRequirement {
  const handle = target.handle;
  // A JSON document's handle carries its manifest entry's requirement (see `documentHandle`).
  const documentRequirement = handle
    ? frameworkCast<{
        _requirement?: ConnectionRequirement;
      }>(handle)._requirement
    : undefined;
  if (documentRequirement) {
    return documentRequirement;
  }
  const profile = handle?.profile;
  const extensions = handle ? extensionsOf(handle) : undefined;
  return {
    ...(profile
      ? {
          profile: {
            name: profile.name,
            range: handle?.range ?? profile.defaultRange,
          },
        }
      : {}),
    ...(extensions
      ? {
          extensions,
        }
      : {}),
    ...(use.op
      ? {
          operations: [
            use.op,
          ],
        }
      : {}),
    ...(use.event
      ? {
          events: [
            use.event,
          ],
        }
      : {}),
  };
}

/** What a harness graph needs of one connection, found before it runs. */
export interface GraphConnectionNeed {
  /** The harness connection (or pool) the handle binds to. */
  readonly name: string;
  readonly profile?: AnyProfile;
  readonly requirement: ConnectionRequirement;
}

/**
 * Every connection need a graph states up front: each `call` and `wait` whose
 * connection is a static handle, with its profile and requirement. The harness
 * registers these profiles (ref kinds) and requirements (start-time
 * negotiation, renegotiated on a manifest change) when it is built.
 */
export function graphConnectionNeeds(graph: Step): GraphConnectionNeed[] {
  const needs: GraphConnectionNeed[] = [];
  someStep(graph, (step) => {
    if (step.kind !== 'call' && step.kind !== 'wait') {
      return false;
    }
    const target = step.connection;
    if (!isHandle(target)) {
      return false;
    }
    const use: StepUse =
      step.kind === 'call'
        ? {
            op: step.op,
          }
        : {
            event: step.event,
          };
    needs.push({
      name: target.options.from ?? target.name,
      ...(target.profile
        ? {
            profile: target.profile,
          }
        : {}),
      requirement: requirementFor(
        {
          name: target.name,
          handle: target,
        },
        use,
      ),
    });
    return false;
  });
  return needs;
}

//#endregion

//#region Resolution

/**
 * Resolves the step's connection through the registry and prepares what a
 * gated call or listen needs. Throws whatever `registry.resolve` throws.
 */
export async function resolveStepConnection(opts: {
  ctx: Context;
  stepId: string;
  target: ConnectionTargetInfo;
  use: StepUse;
  ledgerKey: string | undefined;
}): Promise<StepConnection> {
  const { ctx, stepId, target, use, ledgerKey } = opts;
  const registry = connectionRegistryOf(ctx, target.name);
  const options = target.handle?.options;
  const scope = scopeFor(ctx, options?.fresh);
  const resolved = await registry.resolve({
    name: target.name,
    scope,
    ctx,
    requirement: requirementFor(target, use),
    ...(target.handle?.profile
      ? {
          profile: target.handle.profile,
        }
      : {}),
    ...(options?.fresh
      ? {
          fresh: options.fresh,
        }
      : {}),
    ...(options?.from
      ? {
          from: options.from,
        }
      : {}),
    ...(options?.setup
      ? {
          setup: options.setup,
        }
      : {}),
  });
  noteConnectionUse(ctx, ledgerKey, resolved);
  return {
    resolved,
    scope,
    idempotencyKey: idempotencyKeyFor(ctx, stepId, ledgerKey),
    pending: pendingEntriesFor(ctx, ledgerKey),
  };
}

//#endregion

//#region Witness guard

/**
 * Witness names each verify's `act` is running against, by the id of the
 * context it runs on (a step's lane is a view sharing its context's id).
 */
const WITNESS_GUARDS = new Map<string, Array<ReadonlySet<string>>>();

/**
 * Runs `fn` (a verify's `act`) with `witnesses` guarded: any `call` on one of
 * them that has effects — however its connection was named, by a function or
 * an expression too — is refused with `VERIFY_INVALID` (spec 37 § Witnesses).
 */
export async function withWitnessGuard<T>(
  ctx: Context,
  witnesses: ReadonlyArray<string>,
  fn: () => Promise<T>,
): Promise<T> {
  if (witnesses.length === 0) {
    return fn();
  }
  const guard: ReadonlySet<string> = new Set(witnesses);
  const guards = WITNESS_GUARDS.get(ctx.id) ?? [];
  guards.push(guard);
  WITNESS_GUARDS.set(ctx.id, guards);
  try {
    return await fn();
  } finally {
    const index = guards.indexOf(guard);
    if (index >= 0) {
      guards.splice(index, 1);
    }
    if (guards.length === 0) {
      WITNESS_GUARDS.delete(ctx.id);
    }
  }
}

function isGuardedWitness(ctx: Context, name: string): boolean {
  for (let current: Context | null | undefined = ctx; current; current = current.parent) {
    if (WITNESS_GUARDS.get(current.id)?.some((guard) => guard.has(name))) {
      return true;
    }
  }
  return false;
}

/**
 * Refuses a call on a witness inside a verify's `act` unless the operation is
 * declared without effects.
 *
 * @throws `NoeticConfigError` `VERIFY_INVALID`.
 */
export function refuseWitnessAct(ctx: Context, resolved: ResolvedConnection, op: string): void {
  if (!isGuardedWitness(ctx, resolved.name)) {
    return;
  }
  const info = resolved.manifest.operations[op];
  if (info !== undefined && info.effects !== true) {
    return;
  }
  throw new NoeticConfigError({
    code: 'VERIFY_INVALID',
    message: `A verify's act asked witness '${resolved.name}' to run '${op}', which ${info ? 'has effects' : 'it does not offer'}.`,
    hint: 'A witness can look and cannot touch: act on the subject, or make the connection the subject.',
  });
}

//#endregion

//#region Pending entries

/**
 * Pending ledger entries for one run (spec 23a § Connection Steps): written
 * before a call or wait reaches a server, removed once it has a result. Kept
 * in the harness `StorageAdapter` next to the run's ledger.
 */
export class PendingEntries {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly key: string,
  ) {}

  /** The entry a previous attempt left, or undefined when there is none (or it does not parse). */
  async load(): Promise<PendingEntry | undefined> {
    const raw = await this.storage.get<unknown>(this.key);
    if (raw === null) {
      return undefined;
    }
    const parsed = PendingEntrySchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  async write(entry: PendingEntry): Promise<void> {
    try {
      await this.storage.set(this.key, entry);
    } catch (error) {
      console.warn(
        `connection step: failed to write pending entry "${this.key}":`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async clear(): Promise<void> {
    try {
      await this.storage.delete(this.key);
    } catch (error) {
      console.warn(
        `connection step: failed to clear pending entry "${this.key}":`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/** The storage key of a step's pending entry. */
export function pendingEntryKey(executionId: string, ledgerKey: string): string {
  return `execution:${executionId}:pending:${ledgerKey}`;
}

/**
 * Deletes every pending entry a completed run left behind (an entry is normally
 * cleared when its step gets a result; this catches steps a run never resumed).
 */
export async function clearPendingEntries(
  storage: StorageAdapter,
  executionId: string,
): Promise<void> {
  const keys = await storage.list(`execution:${executionId}:pending:`);
  await Promise.all(keys.map((key) => storage.delete(key)));
}

/** Pending entries apply only to a durable run: one with a ledger, a ledger key and storage. */
function pendingEntriesFor(
  ctx: Context,
  ledgerKey: string | undefined,
): PendingEntries | undefined {
  const storage = harnessOf(ctx).config?.storage;
  const durable = ctx instanceof ContextImpl && ctx.ledger !== undefined;
  if (!storage || !durable || ledgerKey === undefined) {
    return undefined;
  }
  return new PendingEntries(storage, pendingEntryKey(runRootOf(ctx).id, ledgerKey));
}

/**
 * Decides what a resumed step does with the pending entry a previous attempt
 * left (spec 35 § Durability), through the one resume policy in
 * `connections/durability.ts`. Against the same identity instance it returns the
 * entry so the step picks up where it was. Against a replaced connection:
 * `harness.restore(id, { rerun })` naming it, or `replayPrefix: 'free'`, runs
 * live; `'costly'` with a reset resets first; anything else — including a
 * connection that declares no determinism — refuses.
 *
 * @throws `NoeticErrorImpl` `connection_resume_refused` when the replaced connection cannot be driven again.
 */
export async function reconcilePending(
  connection: StepConnection,
  signal: AbortSignal,
  ctx?: Context,
): Promise<PendingEntry | undefined> {
  const entry = await connection.pending?.load();
  if (!entry) {
    return undefined;
  }
  const current = connection.resolved.identity();
  const executionId = connection.scope.executionId;
  const registry = ctx ? harnessOf(ctx).connectionRegistry : undefined;
  const decision = resumeDecision({
    recorded: entry.identity,
    current,
    determinism: connection.resolved.manifest.determinism,
    rerunAllowed: registry?.rerunAllowed?.(executionId, connection.resolved.name) ?? false,
    canReset: connection.resolved.reset !== undefined,
  });
  if (decision === 'keep') {
    return entry;
  }
  if (decision === 'refuse') {
    throw new NoeticErrorImpl({
      kind: 'connection_resume_refused',
      connection: connection.resolved.name,
      reason: `its identity changed from '${entry.identity.instance}' to '${current.instance}' and it cannot be driven again; restore with { rerun: ['${connection.resolved.name}'] } to run it live.`,
    });
  }
  if (decision === 'reset') {
    await connection.resolved.reset?.({
      signal,
    });
  }
  await connection.pending?.clear();
  return undefined;
}

/** Records on the run's ledger that the step at `ledgerKey` used `resolved` (spec 35 § Durability). */
function noteConnectionUse(
  ctx: Context,
  ledgerKey: string | undefined,
  resolved: ResolvedConnection,
): void {
  if (!(ctx instanceof ContextImpl) || !ctx.ledger || ledgerKey === undefined) {
    return;
  }
  const identity = resolved.identity();
  ctx.ledger.noteConnection(ledgerKey, {
    name: resolved.name,
    surface: identity.surface,
    instance: identity.instance,
  });
}

/** What run-level reconciliation needs of the registry. */
export interface ResumeChecker {
  checkResume(params: {
    readonly executionId: string;
    readonly name: string;
    readonly recorded: ConnectionIdentity;
    readonly signal: AbortSignal;
  }): Promise<ResumeDecision>;
}

/**
 * Before a resumed run replays anything, checks every connection its ledger
 * and pending entries were recorded against (spec 35 § Durability). For a
 * replaced connection that may run live (after a reset when that is the
 * decision), the ledger is discarded from the first entry that used it —
 * everything after runs live too, model rounds included — and its pending
 * entries are dropped (their idempotency keys derive from the run and step,
 * so `once` calls still carry their original keys). Resolves the number of
 * ledger entries discarded.
 *
 * @throws `NoeticErrorImpl` `connection_resume_refused` when a replaced connection cannot be driven again.
 */
export async function reconcileResumedConnections(opts: {
  ctx: Context;
  registry: ResumeChecker;
  storage: StorageAdapter | undefined;
  signal: AbortSignal;
}): Promise<number> {
  const { ctx, registry, storage, signal } = opts;
  const ledger = ctx instanceof ContextImpl ? ctx.ledger : undefined;
  const decided = new Map<string, ResumeDecision>();
  const decide = async (name: string, recorded: ConnectionIdentity): Promise<ResumeDecision> => {
    const replaced = decided.get(name);
    if (replaced !== undefined && replaced !== 'keep') {
      return replaced;
    }
    const decision = await registry.checkResume({
      executionId: ctx.id,
      name,
      recorded,
      signal,
    });
    decided.set(name, decision);
    return decision;
  };
  let discardFrom: number | undefined;
  for (const { seq, uses } of ledger?.connectionUses() ?? []) {
    for (const use of uses) {
      const decision = await decide(use.name, use);
      if (decision !== 'keep') {
        discardFrom = Math.min(discardFrom ?? seq, seq);
      }
    }
  }
  await dropReplacedPending(ctx.id, storage, decide);
  if (discardFrom === undefined || !ledger) {
    return 0;
  }
  return ledger.discardFrom(discardFrom);
}

async function dropReplacedPending(
  executionId: string,
  storage: StorageAdapter | undefined,
  decide: (name: string, recorded: ConnectionIdentity) => Promise<ResumeDecision>,
): Promise<void> {
  if (!storage) {
    return;
  }
  const keys = await storage.list(`execution:${executionId}:pending:`);
  for (const key of keys) {
    const parsed = PendingEntrySchema.safeParse(await storage.get<unknown>(key));
    if (!parsed.success) {
      continue;
    }
    const decision = await decide(parsed.data.connection, parsed.data.identity);
    if (decision !== 'keep') {
      await storage.delete(key);
    }
  }
}

//#endregion

//#region Events

/** Emits a connection framework event (`connection_event`, `connection_task`, `stream_changed`). */
export function emitConnectionEvent(
  ctx: Context,
  eventType: string,
  data: Record<string, unknown>,
): void {
  emitFrameworkEvent({
    broadcaster: getBroadcaster(ctx),
    agentName: ctx.harness.config.name,
    eventType,
    data,
  });
}

//#endregion
