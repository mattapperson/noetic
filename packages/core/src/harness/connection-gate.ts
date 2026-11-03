import type { ConnectionEntries, ConnectionStatus } from '@noetic-tools/types';
import { namedEntries } from '../connections/entries';
import type { HarnessConnections, HarnessConnectionsOptions } from '../connections/harness-wiring';
import { createHarnessConnections } from '../connections/harness-wiring';
import type { ConnectionRuntime } from '../connections/registry';
import type { StepConnections } from '../connections/step-tools';
import { connectionViewLayer } from '../connections/views';
import type { AttachedEntry } from '../types/connection-entry';
import { setHarnessInternals } from '../util/harness-internals';
import {
  checkPickNames,
  checkToolChoices,
  collectStepEntries,
  graphConnectionNeeds,
  reconcileResumedConnections,
} from './deps/interpreter';
import { ContextImpl } from './deps/runtime';
import type { Context, ContextLayer, Step, StorageAdapter, Tool } from './deps/types';

/**
 * A harness's connections, as the harness drives them: providers and triggers,
 * negotiation of each run root's needs, and the rerun allowances restores grant
 * (spec 35). The harness holds it in a true private field, so nothing holding
 * `ctx.harness` reaches the registry (spec 35 § Gates).
 */
export class ConnectionGate {
  readonly #connections: HarnessConnections;
  /** Roots whose connection needs are already registered or checked. */
  readonly #negotiatedRoots = new WeakSet<object>();
  /**
   * Connections a `restore(id, { rerun })` let its restored context drive again
   * live, held on that context until its run starts (then granted to the run,
   * and ended with it), so a later plain restore of the same id never inherits
   * them (spec 35 § Durability).
   */
  readonly #reruns = new WeakMap<Context, ReadonlyArray<string>>();
  /** The attached names each turn's context has a view layer for, by root id. */
  readonly #viewed = new Map<string, ReadonlySet<string>>();

  /**
   * Wires the harness's connections and triggers, and records the registry and
   * `verifier` as the harness's private internals, where steps and tools find
   * them without anything public on the harness. A harness with no connections
   * still has a registry, for the ones its turns and steps attach.
   */
  constructor(
    options: HarnessConnectionsOptions & {
      readonly verifier?: unknown;
    },
  ) {
    this.#connections = createHarnessConnections(options);
    setHarnessInternals(options.harness, {
      connectionRegistry: this.#connections.registry,
      verifier: options.verifier,
      secrets: options.secrets,
    });
  }

  /** The connection registry. */
  get registry(): ConnectionRuntime {
    return this.#connections.registry;
  }

  /** One view layer per non-pool connection. */
  get views(): ReadonlyArray<ContextLayer> {
    return this.#connections.views;
  }

  /** The connection tools of the turn rooted at `rootId`, or the harness's alone. */
  tools(rootId?: string): Tool[] {
    return this.#connections.tools(rootId);
  }

  /**
   * Starts a turn's connections: attaches the turn's own `connections` and
   * every entry `graph`'s model steps list, connects them, and returns the
   * turn's connection tools, checking each forced `toolChoice` against them.
   * What it attached is released by `release(root.id)`, and at once when it
   * throws.
   *
   * @throws NoeticConfigError `CONNECTION_INVALID`, `CONNECTION_NAME_TAKEN`,
   * `CONNECTION_TOOL_COLLISION`, `CONNECTION_UNKNOWN` (a pick naming no
   * connection) or `UNKNOWN_TOOL_CHOICE`.
   */
  async openTurn(
    root: Context,
    connections: ConnectionEntries | undefined,
    graph: Step | undefined,
  ): Promise<Tool[]> {
    const viewed = this.#viewed.get(root.id);
    const entries = this.turnEntries(connections, graph).map(
      (entry): AttachedEntry => ({
        ...entry,
        viewed: viewed?.has(entry.name) === true,
      }),
    );
    try {
      await this.#connections.registry.attach(root, entries);
      const tools = this.#connections.tools(root.id);
      if (graph) {
        checkGraph(graph, tools, {
          runtime: this.#connections.registry,
          rootId: root.id,
        });
      }
      return tools;
    } catch (error) {
      await this.release(root.id);
      throw error;
    }
  }

  /**
   * Attaches the entries a graph built during a turn lists — a JSON document a
   * step hydrates, with the connections it declares — which the walk at the
   * turn's start could not see. They
   * join the turn's attachment and are released with it. Returns the turn's
   * connection tools, or undefined when the graph lists no entries.
   *
   * @throws NoeticConfigError `CONNECTION_INVALID`, `CONNECTION_NAME_TAKEN`,
   * `CONNECTION_TOOL_COLLISION`, `CONNECTION_UNKNOWN` (a pick naming no
   * connection) or `UNKNOWN_TOOL_CHOICE`.
   */
  async attachGraph(root: Context, graph: Step): Promise<Tool[] | undefined> {
    const entries = collectStepEntries(graph);
    const registry = this.#connections.registry;
    if (entries.length > 0) {
      await registry.attach(root, entries);
    }
    const tools = this.#connections.tools(root.id);
    checkGraph(graph, tools, {
      runtime: registry,
      rootId: root.id,
    });
    return entries.length > 0 ? tools : undefined;
  }

  /** Releases what the turn rooted at `rootId` attached, once nothing holds it. */
  async release(rootId: string): Promise<void> {
    this.#viewed.delete(rootId);
    await this.#connections.registry.detach(rootId);
  }

  /**
   * View layers for the connections a turn will attach, made before its
   * context exists so they sit where a harness entry's would. `bind(root)`
   * names the turn once its context is made.
   *
   * @throws NoeticConfigError `CONNECTION_INVALID` or `CONNECTION_NAME_TAKEN`
   * for a malformed `connections` option.
   */
  turnViews(
    connections: ConnectionEntries | undefined,
    graph: Step | undefined,
  ): {
    readonly layers: ContextLayer[];
    bind(root: Context): void;
  } {
    const registry = this.#connections.registry;
    const harness = new Set(registry.names());
    const names = new Set(
      this.turnEntries(connections, graph)
        .filter((entry) => !harness.has(entry.name) && entry.config.expose !== 'call')
        .map((entry) => entry.name),
    );
    let rootId: string | undefined;
    return {
      layers: [
        ...names,
      ].map((name) => connectionViewLayer(registry, name, () => rootId)),
      bind: (root) => {
        rootId = root.id;
        this.#viewed.set(root.id, names);
      },
    };
  }

  /** Connects providers and starts triggers. Idempotent. */
  async start(): Promise<void> {
    await this.#connections.start();
  }

  /** Each connection's state, identity and pool usage; one entry for `name`, or all. */
  status(name?: string): ReadonlyArray<ConnectionStatus> {
    return this.#connections.registry.status(name);
  }

  /** Stops triggers and releases every connection. */
  async close(): Promise<void> {
    await this.#connections.close();
  }

  /**
   * Registers what the agent graph's handles need: their profiles (ref kinds) and
   * requirements, negotiated at start and again on every manifest change
   * (spec 35 § Connection registry). Names the harness lacks are left to fail
   * with `CONNECTION_UNKNOWN` when the step runs.
   */
  registerGraphNeeds(agentGraph: Step | undefined): void {
    const registry = this.#connections.registry;
    if (!agentGraph) {
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
    const registry = this.#connections.registry;
    if (this.#negotiatedRoots.has(root)) {
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
    this.#connections.registry.allowRerun(ctx.id, rerun);
  }

  /**
   * Before a resumed run replays anything, checks the connections its ledger and
   * pending entries were recorded against, discarding the ledger from the first
   * entry whose connection was replaced (spec 35 § Durability).
   *
   * @throws NoeticErrorImpl `connection_resume_refused` when a replaced connection is unsafe to drive again.
   */
  async reconcile(ctx: Context, storage: StorageAdapter | undefined): Promise<void> {
    const registry = this.#connections.registry;
    // A run with no connections has none to check.
    if (
      !(ctx instanceof ContextImpl) ||
      !ctx.ledger ||
      registry.visibleNames(ctx.id).length === 0
    ) {
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
    this.#connections.registry.orphanRun(executionId);
  }

  /** Releases a finished root run's connections and pool leases. */
  async releaseRun(executionId: string): Promise<void> {
    await this.#connections.registry.releaseRun(executionId);
  }

  /** A turn's own entries, then the ones its graph's steps list. */
  private turnEntries(
    connections: ConnectionEntries | undefined,
    graph: Step | undefined,
  ): AttachedEntry[] {
    const where = 'execute() connections';
    return [
      ...namedEntries(connections, where).map(
        (entry): AttachedEntry => ({
          ...entry,
          scope: 'turn',
          where,
        }),
      ),
      ...(graph ? collectStepEntries(graph) : []),
    ];
  }
}

/** Checks a graph against the turn's attached connections: each pick's name, then each forced tool. */
function checkGraph(graph: Step, tools: ReadonlyArray<Tool>, turn: StepConnections): void {
  checkPickNames(graph, turn);
  checkToolChoices(graph, tools, turn);
}
