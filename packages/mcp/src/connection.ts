/**
 * One connection over an MCP session (spec 35 § The provider contract):
 * operations are tools (or declared aliases onto tools), reads are resources,
 * long operations are tasks, events come through the Events extension, and
 * the identity is `noetic://identity` — or, for a server with no profile
 * declaration, the MCP session itself.
 *
 * When one server serves several connections (`instances` in its
 * declaration), each connection's requests carry
 * `_meta["tools.noetic/instance"]`.
 */

import type {
  ArtifactStore,
  CallOptions,
  CallResult,
  Connection,
  ConnectionErrorPayload,
  ConnectionIdentity,
  ConnectionManifest,
  ConnectionTasks,
  EventStream,
  ListenRequest,
} from '@noetic-tools/types';
import {
  CONFIRMED_META,
  IDEMPOTENCY_KEY_META,
  INSTANCE_META,
  NoeticErrorImpl,
} from '@noetic-tools/types';
import type { Anomaly, BlindSpot } from '@noetic-tools/types/verify';
import type { McpOptions } from './config';
import { DEFAULT_POLL_INTERVAL_MS } from './config';
import { resourceValue, toolResultOutput } from './content';
import type { Catalog, Discovery, ServedParts } from './declaration';
import { discover } from './declaration';
import { connectionError, requestErrorPayload, toolErrorPayload } from './errors';
import { openEventStream, terminatedEventStream } from './events';
import { coverageUri, parseAnomalies, parseCoverage } from './evidence';
import type { McpSession } from './session';
import { createTasks } from './tasks';
import type { ToolResult } from './wire';
import {
  CallResponseSchema,
  COVERAGE_URI,
  IDENTITY_CHANGED_EVENT,
  IDENTITY_URI,
  IdentitySchema,
  McpMethod,
  McpNotification,
  ReadResourceResultSchema,
  ToolResultSchema,
  UniversalTool,
} from './wire';

//#region Types

/** @public What a connection is built from. */
export interface McpConnectionInit {
  /** The harness connection (or pool) name. */
  readonly name: string;
  readonly session: McpSession;
  readonly served: ServedParts;
  readonly discovery: Discovery;
  readonly identity: ConnectionIdentity;
  readonly artifacts: ArtifactStore;
  readonly options: McpOptions;
  readonly catalog: Catalog;
  /** The instance this connection targets, when the server serves several. */
  readonly instance?: string;
  /** Called once by `release()`. */
  readonly onRelease: () => Promise<void>;
}

type ChangeListener = (change: 'manifest' | 'identity') => void;

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameIdentity(a: ConnectionIdentity, b: ConnectionIdentity): boolean {
  return a.surface === b.surface && a.instance === b.instance && a.epoch === b.epoch;
}

function taskTools(served: ServedParts): ReadonlySet<string> {
  return new Set(
    served.tools
      .filter(
        (tool) =>
          tool.execution?.taskSupport === 'required' || tool.execution?.taskSupport === 'optional',
      )
      .map((tool) => tool.name),
  );
}

function failed(connection: string, op: string, error: ConnectionErrorPayload): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'connection_failed',
    connection,
    op,
    error,
  });
}

//#endregion

//#region Public API

/**
 * @public
 * The identity of a session: `noetic://identity` for a declaring server, else
 * the MCP session (its transport session id, or a fresh id per session).
 */
export async function readIdentity(source: {
  session: McpSession;
  discovery: Discovery;
  meta: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}): Promise<ConnectionIdentity> {
  const { session, discovery, meta, signal } = source;
  if (discovery.declaration === undefined) {
    return {
      surface: 'mcp',
      instance: session.sessionId ?? crypto.randomUUID(),
    };
  }
  const result = await session.request(
    McpMethod.ResourcesRead,
    {
      uri: IDENTITY_URI,
      _meta: meta,
    },
    ReadResourceResultSchema,
    {
      signal,
    },
  );
  const text = result.contents[0]?.text;
  const parsed = IdentitySchema.safeParse(text === undefined ? undefined : JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`${IDENTITY_URI} is malformed`);
  }
  return {
    surface: parsed.data.surface,
    instance: parsed.data.instance,
    ...(parsed.data.epoch === undefined
      ? {}
      : {
          epoch: parsed.data.epoch,
        }),
  };
}

/** @public A connection over one MCP session. */
export class McpConnection implements Connection {
  readonly id: string;
  readonly tasks: ConnectionTasks;
  readonly closed: Promise<{
    reason: string;
  }>;
  /** Present when the server serves `noetic.reset`. */
  readonly reset?: (opts: { signal: AbortSignal }) => Promise<void>;
  /** Present when the server serves `noetic://coverage`. */
  readonly coverage?: (
    since: string | null,
    opts: {
      signal: AbortSignal;
    },
  ) => Promise<ReadonlyArray<BlindSpot>>;
  /** Present when the server serves `noetic.detect`. */
  readonly detect?: (
    since: string | null,
    opts: {
      signal: AbortSignal;
    },
  ) => Promise<ReadonlyArray<Anomaly>>;

  private readonly init: McpConnectionInit;
  private discovery: Discovery;
  private served: ServedParts;
  private currentIdentity: ConnectionIdentity;
  private unavailableReason: string | undefined;
  /** Set when a re-read of `noetic://identity` failed; cleared by the next successful one. */
  private identityUnreadable = false;
  private readonly listeners = new Set<ChangeListener>();
  private readonly lifetime = new AbortController();
  private readonly offs: Array<() => void> = [];
  private released = false;
  private settleClosed: (value: { reason: string }) => void = () => {};

  constructor(init: McpConnectionInit) {
    this.init = init;
    this.id = init.instance === undefined ? init.name : `${init.name}/${init.instance}`;
    this.discovery = init.discovery;
    this.served = init.served;
    this.currentIdentity = init.identity;
    this.closed = new Promise((resolve) => {
      this.settleClosed = resolve;
    });
    void init.session.closed.then(({ reason }) => this.finish(reason));
    this.tasks = createTasks({
      session: init.session,
      artifacts: init.artifacts,
      meta: this.meta(),
      pollIntervalMs: init.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    });
    if (init.discovery.universal.has(UniversalTool.Reset)) {
      this.reset = (opts) => this.runReset(opts.signal);
    }
    if (init.discovery.hasCoverage) {
      this.coverage = (since, opts) => this.readCoverage(since, opts.signal);
    }
    if (init.discovery.universal.has(UniversalTool.Detect)) {
      this.detect = (since, opts) => this.runDetect(since, opts.signal);
    }
    this.watch();
  }

  /** @public What the connection offers. */
  get manifest(): ConnectionManifest {
    return this.discovery.manifest;
  }

  /** @public The OVP subject it drives. */
  get identity(): ConnectionIdentity {
    return this.currentIdentity;
  }

  /** @public Why the connection is unavailable, if it is. */
  get unavailable(): string | undefined {
    return this.unavailableReason ?? this.init.session.closeReasonText;
  }

  /** @public Runs one operation. */
  async call(op: string, args: unknown, opts: CallOptions): Promise<CallResult> {
    const down = this.unavailable;
    if (down !== undefined) {
      return {
        status: 'error',
        error: connectionError('unavailable', `The connection is unavailable: ${down}`),
      };
    }
    const route = this.discovery.routes.get(op);
    if (route === undefined || !Object.hasOwn(this.manifest.operations, op)) {
      return {
        status: 'error',
        error: connectionError('undeclared', `'${op}' is not an operation of this connection.`),
      };
    }
    if (args !== undefined && !isRecord(args)) {
      return {
        status: 'error',
        error: connectionError('malformed', `'${op}' takes an object of arguments.`),
      };
    }
    return this.send(route.tool, {
      args: {
        ...(args ?? {}),
        ...route.fixed,
      },
      opts,
    });
  }

  /**
   * @public
   * Calls a tool by its MCP name, bypassing the operation table — for the
   * conformance suite, which must see how a server answers names it does not
   * declare.
   */
  async callTool(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    opts: CallOptions,
  ): Promise<CallResult> {
    return this.send(tool, {
      args,
      opts,
    });
  }

  /** @public Reads a resource by read name (or by URI). */
  async read(
    resource: string,
    opts: {
      signal: AbortSignal;
    },
  ): Promise<unknown> {
    // A read is a declared read by name, or the universal coverage resource
    // (spec 36 § Parts every server provides) — never an arbitrary URI.
    const uri =
      this.discovery.readUris.get(resource) ??
      (resource.startsWith(COVERAGE_URI) ? resource : undefined);
    if (uri === undefined) {
      throw failed(
        this.init.name,
        resource,
        connectionError('undeclared', `'${resource}' is not a read of this connection.`),
      );
    }
    try {
      const result = await this.init.session.request(
        McpMethod.ResourcesRead,
        {
          uri,
          _meta: this.meta(),
        },
        ReadResourceResultSchema,
        {
          signal: opts.signal,
        },
      );
      return await resourceValue(result.contents, this.init.artifacts);
    } catch (error) {
      opts.signal.throwIfAborted();
      throw failed(this.init.name, resource, requestErrorPayload(error));
    }
  }

  /** @public Listens for one event type. */
  listen(req: ListenRequest): EventStream {
    if (!Object.hasOwn(this.manifest.events, req.event)) {
      return terminatedEventStream(`'${req.event}' is not an event of this connection`);
    }
    return this.openStream(req);
  }

  /** @public Subscribes to manifest and identity changes. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** @public Gives the connection back. Idempotent. */
  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    this.lifetime.abort();
    for (const off of this.offs.splice(0)) {
      off();
    }
    await this.init.onRelease();
    this.finish('released');
  }

  private finish(reason: string): void {
    this.lifetime.abort();
    this.settleClosed({
      reason,
    });
  }

  private meta(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      ...(this.init.instance === undefined
        ? {}
        : {
            [INSTANCE_META]: this.init.instance,
          }),
      ...extra,
    };
  }

  private openStream(req: ListenRequest): EventStream {
    return openEventStream(
      {
        session: this.init.session,
        artifacts: this.init.artifacts,
        meta: this.meta(),
        pollIntervalMs: this.init.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        ...(this.init.options.webhooks === undefined
          ? {}
          : {
              webhooks: this.init.options.webhooks,
            }),
      },
      req,
    );
  }

  private async send(
    tool: string,
    call: {
      args: Readonly<Record<string, unknown>>;
      opts: CallOptions;
    },
  ): Promise<CallResult> {
    const { args, opts } = call;
    const params = {
      name: tool,
      arguments: args,
      _meta: this.meta({
        [IDEMPOTENCY_KEY_META]: opts.idempotencyKey,
        ...(opts.confirmed === true
          ? {
              [CONFIRMED_META]: true,
            }
          : {}),
      }),
      ...(taskTools(this.served).has(tool)
        ? {
            task: {},
          }
        : {}),
    };
    let response: ToolResult & {
      task?: {
        taskId: string;
      };
    };
    try {
      response = await this.init.session.request(McpMethod.ToolsCall, params, CallResponseSchema, {
        signal: opts.signal,
      });
    } catch (error) {
      opts.signal.throwIfAborted();
      return {
        status: 'error',
        error: requestErrorPayload(error),
      };
    }
    if (response.task !== undefined) {
      return {
        status: 'task',
        taskId: response.task.taskId,
      };
    }
    if (response.isError === true) {
      return {
        status: 'error',
        error: toolErrorPayload(response),
      };
    }
    return {
      status: 'ok',
      output: await toolResultOutput(response, this.init.artifacts),
    };
  }

  /**
   * @public
   * Calls a tool by its MCP name and waits for its outcome, following a task
   * to completion.
   * @throws NoeticError `connection_failed` when the server refuses or fails it.
   */
  async runTool(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const result = await this.send(tool, {
      args,
      opts: {
        signal,
        idempotencyKey: `${tool}:${crypto.randomUUID()}`,
      },
    });
    if (result.status === 'error') {
      throw failed(this.init.name, tool, result.error);
    }
    if (result.status === 'task') {
      const outcome = await this.tasks.result(result.taskId, {
        signal,
      });
      if (outcome.status === 'error') {
        throw failed(this.init.name, tool, outcome.error);
      }
      return outcome.output;
    }
    return result.output;
  }

  private async runReset(signal: AbortSignal): Promise<void> {
    await this.runTool(UniversalTool.Reset, {}, signal);
    await this.refreshIdentity();
  }

  private async readCoverage(
    since: string | null,
    signal: AbortSignal,
  ): Promise<ReadonlyArray<BlindSpot>> {
    const value = await this.read(coverageUri(since), {
      signal,
    });
    const spots = parseCoverage(value);
    if (spots === undefined) {
      throw failed(
        this.init.name,
        'noetic://coverage',
        connectionError('malformed', 'Coverage is malformed.'),
      );
    }
    return spots;
  }

  private async runDetect(
    since: string | null,
    signal: AbortSignal,
  ): Promise<ReadonlyArray<Anomaly>> {
    const output = await this.runTool(
      UniversalTool.Detect,
      {
        since,
      },
      signal,
    );
    const anomalies = parseAnomalies(output);
    if (anomalies === undefined) {
      throw failed(
        this.init.name,
        UniversalTool.Detect,
        connectionError('malformed', 'Anomalies are malformed.'),
      );
    }
    return anomalies;
  }

  private emit(change: 'manifest' | 'identity'): void {
    for (const listener of [
      ...this.listeners,
    ]) {
      listener(change);
    }
  }

  private async refreshIdentity(): Promise<void> {
    if (this.discovery.declaration === undefined) {
      return;
    }
    try {
      const next = await readIdentity({
        session: this.init.session,
        discovery: this.discovery,
        meta: this.meta(),
        signal: this.lifetime.signal,
      });
      if (this.identityUnreadable) {
        this.identityUnreadable = false;
        this.unavailableReason = undefined;
        this.emit('manifest');
      }
      if (sameIdentity(next, this.currentIdentity)) {
        return;
      }
      this.currentIdentity = next;
      this.emit('identity');
    } catch (error) {
      if (this.lifetime.signal.aborted) {
        return;
      }
      // The thing may have been replaced: until its identity reads again, the
      // connection cannot be trusted with refs or recorded results.
      this.identityUnreadable = true;
      this.unavailableReason = `its identity could not be re-read after a change: ${error instanceof Error ? error.message : String(error)}`;
      this.emit('manifest');
    }
  }

  private async refreshManifest(): Promise<void> {
    try {
      const served = await this.init.session.listServed(this.lifetime.signal);
      const outcome = discover(this.init.session.capabilities, served, this.init.catalog);
      this.served = served;
      if (!outcome.ok) {
        this.unavailableReason = `the server ${outcome.reason}`;
        this.emit('manifest');
        return;
      }
      this.unavailableReason = this.identityUnreadable ? this.unavailableReason : undefined;
      this.discovery = outcome.discovery;
      this.emit('manifest');
    } catch {
      // A failed re-list leaves the last manifest in place; a closed session ends the connection.
    }
  }

  private watch(): void {
    const { session } = this.init;
    const relist = (): void => {
      void this.refreshManifest();
    };
    this.offs.push(
      session.on(McpNotification.ToolsListChanged, relist),
      session.on(McpNotification.ResourcesListChanged, relist),
      session.on(McpNotification.EventsListChanged, relist),
      session.on(McpNotification.ResourceUpdated, (params) => {
        if (params.uri === IDENTITY_URI) {
          void this.refreshIdentity();
        }
      }),
    );
    if (this.served.events.some((event) => event.name === IDENTITY_CHANGED_EVENT)) {
      void this.followIdentityEvents();
    }
  }

  private async followIdentityEvents(): Promise<void> {
    const stream = this.openStream({
      event: IDENTITY_CHANGED_EVENT,
      signal: this.lifetime.signal,
    });
    for await (const message of stream) {
      if (message.type === 'event') {
        await this.refreshIdentity();
      }
    }
  }
}

/** @public Parses a tool result loosely (exposed for the conformance runner). */
export function parseToolResult(value: unknown): ToolResult | undefined {
  const parsed = ToolResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

//#endregion
