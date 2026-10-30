import type { ConnectionStatus } from '@noetic-tools/types';
import type { HarnessConnections, HarnessConnectionsOptions } from '../connections/harness-wiring';
import { createHarnessConnections } from '../connections/harness-wiring';
import type { ConnectionRuntime } from '../connections/registry';
import { setHarnessInternals } from '../util/harness-internals';
import { graphConnectionNeeds, reconcileResumedConnections } from './deps/interpreter';
import { ContextImpl } from './deps/runtime';
import type { Context, ContextLayer, Step, StorageAdapter, Tool } from './deps/types';

/**
 * A harness's connections, as the harness drives them: providers and triggers,
 * negotiation of each run root's needs, and the rerun allowances restores grant
 * (spec 35). The harness holds it in a true private field, so nothing holding
 * `ctx.harness` reaches the registry (spec 35 § Gates).
 */
export class ConnectionGate {
  readonly #connections?: HarnessConnections;
  /** Roots whose connection needs are already registered or checked. */
  readonly #negotiatedRoots = new WeakSet<object>();
  /**
   * Connections a `restore(id, { rerun })` let its restored context drive again
   * live, held on that context until its run starts (then granted to the run,
   * and ended with it), so a later plain restore of the same id never inherits
   * them (spec 35 § Durability).
   */
  readonly #reruns = new WeakMap<Context, ReadonlyArray<string>>();

  /**
   * Wires the harness's connections and triggers, when it has any, and records
   * the registry and `verifier` as the harness's private internals, where steps
   * and tools find them without anything public on the harness.
   */
  constructor(
    options: HarnessConnectionsOptions & {
      readonly verifier?: unknown;
    },
  ) {
    if (options.connections || (options.triggers && options.triggers.length > 0)) {
      this.#connections = createHarnessConnections(options);
    }
    setHarnessInternals(options.harness, {
      connectionRegistry: this.#connections?.registry,
      verifier: options.verifier,
    });
  }

  /** The connection registry, absent on a harness without connections or triggers. */
  get registry(): ConnectionRuntime | undefined {
    return this.#connections?.registry;
  }

  /** One view layer per non-pool connection. */
  get views(): ReadonlyArray<ContextLayer> {
    return this.#connections?.views ?? [];
  }

  /** This turn's connection tools. */
  tools(): Tool[] {
    return this.#connections?.tools() ?? [];
  }

  /** Connects providers and starts triggers. Idempotent. */
  async start(): Promise<void> {
    await this.#connections?.start();
  }

  /** Each connection's state, identity and pool usage; one entry for `name`, or all. */
  status(name?: string): ReadonlyArray<ConnectionStatus> {
    return this.#connections?.registry.status(name) ?? [];
  }

  /** Stops triggers and releases every connection. */
  async close(): Promise<void> {
    await this.#connections?.close();
  }

  /**
   * Registers what the agent graph's handles need: their profiles (ref kinds) and
   * requirements, negotiated at start and again on every manifest change
   * (spec 35 § Connection registry). Names the harness lacks are left to fail
   * with `CONNECTION_UNKNOWN` when the step runs.
   */
  registerGraphNeeds(agentGraph: Step | undefined): void {
    const registry = this.#connections?.registry;
    if (!registry || !agentGraph) {
      return;
    }
    this.#negotiatedRoots.add(agentGraph);
    const known = new Set(registry.names());
    for (const need of graphConnectionNeeds(agentGraph)) {
      if (need.profile) {
        registry.registerProfile(need.profile);
      }
      if (known.has(need.name)) {
        registry.require(need.name, need.requirement, {
          setup: need.setup,
        });
      }
    }
  }

  /**
   * Negotiates a `run()` root that is not the agent graph after the providers
   * have connected: registers its handles' profiles and checks its requirements
   * against each connection's manifest, so a root that needs more than a
   * connection offers fails before it executes, as a document does (spec 35
   * § Negotiation). A root is remembered as negotiated only once every
   * connection it needs was checked; one whose connection was down (or whose
   * pool has provisioned nothing yet) is checked again on its next run.
   *
   * @throws `NoeticConfigError` `CONNECTION_UNSATISFIED` when a connection falls short.
   */
  negotiateRoot(root: Step): void {
    const registry = this.#connections?.registry;
    if (!registry || this.#negotiatedRoots.has(root)) {
      return;
    }
    const known = new Set(registry.names());
    let checkedAll = true;
    for (const need of graphConnectionNeeds(root)) {
      if (need.profile) {
        registry.registerProfile(need.profile);
      }
      if (
        known.has(need.name) &&
        !registry.check(need.name, need.requirement, {
          setup: need.setup,
        })
      ) {
        checkedAll = false;
      }
    }
    if (checkedAll) {
      this.#negotiatedRoots.add(root);
    }
  }

  /** Holds the rerun allowance a restore grants on the context it returns. */
  holdReruns(ctx: Context, rerun: ReadonlyArray<string>): void {
    this.#reruns.set(ctx, rerun);
  }

  /** Ends the rerun allowance `ctx` carries, for a run that failed before executing. */
  dropReruns(ctx: Context): void {
    this.#reruns.delete(ctx);
  }

  /**
   * Hands the rerun allowance a restore left on `ctx` to its run, which ends it
   * when it finishes (released or orphaned, see `endRun`).
   */
  grantReruns(ctx: Context): void {
    const rerun = this.#reruns.get(ctx);
    if (!rerun) {
      return;
    }
    this.#reruns.delete(ctx);
    this.#connections?.registry.allowRerun(ctx.id, rerun);
  }

  /**
   * Before a resumed run replays anything, checks the connections its ledger and
   * pending entries were recorded against, discarding the ledger from the first
   * entry whose connection was replaced (spec 35 § Durability).
   *
   * @throws NoeticErrorImpl `connection_resume_refused` when a replaced connection is unsafe to drive again.
   */
  async reconcile(ctx: Context, storage: StorageAdapter | undefined): Promise<void> {
    const registry = this.#connections?.registry;
    if (!registry || !(ctx instanceof ContextImpl) || !ctx.ledger) {
      return;
    }
    await reconcileResumedConnections({
      ctx,
      registry,
      storage,
      signal: ctx.abortSignal,
    });
  }

  /**
   * Ends a root run's hold on its connections. A failed run keeps its pool
   * leases, unrenewed, so a resume within the reclaim window gets the same
   * connections back and an abandoned one frees them (spec 35 § Pools and
   * leases); a finished run releases them.
   */
  orphanRun(executionId: string): void {
    this.#connections?.registry.orphanRun?.(executionId);
  }

  /** Releases a finished root run's connections and pool leases. */
  async releaseRun(executionId: string): Promise<void> {
    await this.#connections?.registry.releaseRun(executionId);
  }
}
