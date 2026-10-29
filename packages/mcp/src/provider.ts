/**
 * `mcp()` — any MCP server as a connection provider (spec 35). `connect()`
 * opens a session, discovers what the server offers and declares, and returns
 * one connection (or one per declared instance). `provision()` backs a pool:
 * through the server's `noetic.provision` / `noetic.release` when it serves
 * them, else — for a subprocess or caller-built transport and an empty setup —
 * a fresh session per connection.
 */

import type { ConnectionProvider, ConnectOptions } from '@noetic-tools/types';
import { ConnectionUnsatisfiedError, isNoeticError } from '@noetic-tools/types';
import type { McpConfig, McpOptions, ResolvedMcpConfig } from './config';
import { isStdioTarget, isTransportTarget, resolveMcpConfig } from './config';
import { McpConnection, readIdentity } from './connection';
import type { Catalog, Discovery, ServedParts } from './declaration';
import { discover } from './declaration';
import { unavailable } from './errors';
import { McpSession } from './session';
import { ProvisionResultSchema, UniversalTool } from './wire';

//#region Types

interface OpenedSession {
  readonly session: McpSession;
  readonly served: ServedParts;
  readonly discovery: Discovery;
}

//#endregion

//#region Helpers

function uniqueById<
  T extends {
    readonly id: string;
  },
>(items: ReadonlyArray<T>): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  return [
    ...byId.values(),
  ];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

//#endregion

//#region Provider

/** @public A `ConnectionProvider` backed by one MCP server. */
export class McpProvider implements ConnectionProvider {
  readonly kind = 'mcp';
  readonly config: ResolvedMcpConfig;

  constructor(config: ResolvedMcpConfig) {
    this.config = config;
  }

  /**
   * The profiles and extensions the declaration is checked against: the ones
   * given to `mcp()` plus the ones the harness's handles name (deduplicated by id).
   */
  private catalogFor(opts: ConnectOptions): Catalog {
    return {
      profiles: uniqueById([
        ...(this.config.options.profiles ?? []),
        ...(opts.profiles ?? []),
      ]),
      extensions: uniqueById([
        ...(this.config.options.extensions ?? []),
        ...(opts.extensions ?? []),
      ]),
    };
  }

  /**
   * @public
   * Connects. Rejects with `connection_unavailable` when the server cannot be
   * started or reached, or contradicts its own declaration.
   */
  async connect(opts: ConnectOptions): Promise<ReadonlyArray<McpConnection>> {
    const opened = await this.open(opts);
    const instances = opened.discovery.declaration?.instances ?? [];
    const targets =
      instances.length > 1
        ? instances.map((i) => i.id)
        : [
            undefined,
          ];
    let open = targets.length;
    const onRelease = async (): Promise<void> => {
      open--;
      if (open === 0) {
        await opened.session.close();
      }
    };
    try {
      return await Promise.all(
        targets.map((instance) =>
          this.build({
            opened,
            opts,
            onRelease,
            ...(instance === undefined
              ? {}
              : {
                  instance,
                }),
          }),
        ),
      );
    } catch (error) {
      await opened.session.close('discovery failed');
      throw isNoeticError(error) ? error : unavailable(opts.name, describe(error));
    }
  }

  /**
   * @public
   * Creates a fresh connection for a pool.
   *
   * @throws ConnectionUnsatisfiedError (`CONNECTION_UNSATISFIED`, missing
   *   operation `noetic.provision`) when the server cannot provision and a
   *   fresh session would not be a fresh connection.
   */
  async provision(setup: Record<string, unknown>, opts: ConnectOptions): Promise<McpConnection> {
    const opened = await this.open(opts);
    try {
      if (opened.discovery.universal.has(UniversalTool.Provision)) {
        return await this.provisionInstance(opened, setup, opts);
      }
      const ownProcess = isStdioTarget(this.config.target) || isTransportTarget(this.config.target);
      if (!ownProcess || Object.keys(setup).length > 0) {
        throw new ConnectionUnsatisfiedError({
          connection: opts.name,
          missing: {
            kind: 'operation',
            op: UniversalTool.Provision,
          },
          hint: 'Use a server that serves noetic.provision, or a stdio server with no setup.',
        });
      }
      return await this.build({
        opened,
        opts,
        onRelease: () => opened.session.close(),
      });
    } catch (error) {
      await opened.session.close('provision failed');
      throw error;
    }
  }

  private async open(opts: ConnectOptions): Promise<OpenedSession> {
    let session: McpSession;
    try {
      session = await McpSession.open(this.config.target, this.config.options, opts.signal);
    } catch (error) {
      opts.signal.throwIfAborted();
      throw unavailable(
        opts.name,
        `the MCP server could not be started or reached: ${describe(error)}`,
      );
    }
    try {
      const served = await session.listServed(opts.signal);
      const outcome = discover(session.capabilities, served, this.catalogFor(opts));
      if (!outcome.ok) {
        throw unavailable(opts.name, `the server ${outcome.reason}`);
      }
      return {
        session,
        served,
        discovery: outcome.discovery,
      };
    } catch (error) {
      await session.close('discovery failed');
      opts.signal.throwIfAborted();
      throw isNoeticError(error)
        ? error
        : unavailable(opts.name, `capability discovery failed: ${describe(error)}`);
    }
  }

  private async build(params: {
    opened: OpenedSession;
    opts: ConnectOptions;
    onRelease: () => Promise<void>;
    instance?: string;
  }): Promise<McpConnection> {
    const { opened, opts } = params;
    const meta = params.instance === undefined ? {} : instanceMeta(params.instance);
    const identity = await readIdentity({
      session: opened.session,
      discovery: opened.discovery,
      meta,
      signal: opts.signal,
    });
    return new McpConnection({
      name: opts.name,
      session: opened.session,
      served: opened.served,
      discovery: opened.discovery,
      identity,
      artifacts: opts.artifacts,
      options: this.config.options,
      catalog: this.catalogFor(opts),
      onRelease: params.onRelease,
      ...(params.instance === undefined
        ? {}
        : {
            instance: params.instance,
          }),
    });
  }

  private async provisionInstance(
    opened: OpenedSession,
    setup: Record<string, unknown>,
    opts: ConnectOptions,
  ): Promise<McpConnection> {
    const control = await this.build({
      opened,
      opts,
      onRelease: async () => {},
    });
    let output: unknown;
    try {
      output = await control.runTool(
        UniversalTool.Provision,
        {
          setup,
        },
        opts.signal,
      );
    } finally {
      await control.release();
    }
    const parsed = ProvisionResultSchema.safeParse(output);
    if (!parsed.success) {
      throw unavailable(opts.name, `${UniversalTool.Provision} returned no instance id`);
    }
    const instance = parsed.data.instance;
    return this.build({
      opened,
      opts,
      instance,
      onRelease: async () => {
        await opened.session
          .request(
            'tools/call',
            {
              name: UniversalTool.Release,
              arguments: {
                instance,
              },
              _meta: instanceMeta(instance),
            },
            ProvisionReleaseSchema,
          )
          .catch(() => {});
        await opened.session.close();
      },
    });
  }
}

const ProvisionReleaseSchema = ProvisionResultSchema.partial();

function instanceMeta(instance: string): Record<string, unknown> {
  return {
    'tools.noetic/instance': instance,
  };
}

//#endregion

//#region Public API

/**
 * @public
 * Any MCP server as a connection. Takes a command line
 * (`'npx @playwright/mcp@latest'`), `{ command, args, env, cwd }`,
 * `{ url, headers }`, or `{ transport }`, with options such as `webhooks`.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when the configuration is malformed.
 */
export function mcp(config: McpConfig, options?: McpOptions): McpProvider {
  return new McpProvider(resolveMcpConfig(config, options));
}

//#endregion
