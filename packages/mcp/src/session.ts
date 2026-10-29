/**
 * One MCP session: the SDK client, its transport, the handshake under a
 * deadline, paginated discovery of tools, resources and events, and a
 * dispatcher for the extension notifications the SDK does not know.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Notification, Request, Result } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { McpOptions, McpServerTarget } from './config';
import { DEFAULT_MCP_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS } from './config';
import type { ServedParts } from './declaration';
import { hasDeclaration } from './declaration';
import { createTransport } from './transports';
import type { EventInfo, ResourceInfo, ToolInfo } from './wire';
import {
  EVENTS_EXTENSION,
  EventListSchema,
  McpMethod,
  ResourceListSchema,
  TASKS_EXTENSION,
  ToolListSchema,
} from './wire';

//#region Types

/** @public A handler for one notification method. */
export type NotificationHandler = (params: Readonly<Record<string, unknown>>) => void;

/** @public Options for one raw request. */
export interface SessionRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

//#endregion

//#region Constants

const DEFAULT_CLIENT_INFO = {
  name: 'noetic-mcp',
  version: '1.0.0',
};

/** Pages read per list before discovery gives up on a server that never stops paginating. */
const MAX_PAGES = 100;

//#endregion

//#region Helpers

async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([
      work,
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

//#endregion

//#region Session

/** @public A live MCP session. */
export class McpSession {
  readonly client: Client<Request, Notification, Result>;
  readonly transport: Transport;
  readonly options: McpOptions;
  /** Resolves with the reason once the session closes. */
  readonly closed: Promise<{
    reason: string;
  }>;
  private readonly handlers = new Map<string, Set<NotificationHandler>>();
  private closeReason: string | undefined;
  private settleClosed: (value: { reason: string }) => void = () => {};

  private constructor(
    client: Client<Request, Notification, Result>,
    transport: Transport,
    options: McpOptions,
  ) {
    this.client = client;
    this.transport = transport;
    this.options = options;
    this.closed = new Promise((resolve) => {
      this.settleClosed = resolve;
    });
    client.onclose = () => {
      this.markClosed('the MCP session closed');
    };
    client.fallbackNotificationHandler = async (notification) => {
      this.dispatch(notification.method, notification.params);
    };
  }

  /**
   * @public
   * Starts a transport, completes the handshake within the budget, and returns
   * the open session. On failure the transport is closed before rethrowing.
   */
  static async open(
    target: McpServerTarget,
    options: McpOptions,
    signal: AbortSignal,
  ): Promise<McpSession> {
    signal.throwIfAborted();
    const transport = await createTransport(target);
    const client = new Client<Request, Notification, Result>(
      options.clientInfo ?? DEFAULT_CLIENT_INFO,
      {
        capabilities: {
          extensions: {
            [TASKS_EXTENSION]: {},
            [EVENTS_EXTENSION]: {},
          },
        },
      },
    );
    const session = new McpSession(client, transport, options);
    const onAbort = (): void => {
      void session.close('aborted');
    };
    signal.addEventListener('abort', onAbort, {
      once: true,
    });
    try {
      await withDeadline(
        client.connect(transport),
        options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
        'The MCP handshake',
      );
      return session;
    } catch (error) {
      await session.close('handshake failed');
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** @public The server's declared capabilities, as a plain record. */
  get capabilities(): Readonly<Record<string, unknown>> {
    const caps = this.client.getServerCapabilities();
    return isRecord(caps) ? caps : {};
  }

  /** @public One extension capability value, or `undefined` when not declared. */
  extension(key: string): unknown {
    const extensions = this.capabilities.extensions;
    return isRecord(extensions) ? extensions[key] : undefined;
  }

  /** @public Whether the server supports the Tasks extension (or core MCP tasks). */
  get supportsTasks(): boolean {
    return this.extension(TASKS_EXTENSION) !== undefined || this.capabilities.tasks !== undefined;
  }

  /** @public Whether the session is closed, and why. */
  get closeReasonText(): string | undefined {
    return this.closeReason;
  }

  /** @public The MCP session id, when the transport has one. */
  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  /** @public Sends a raw request and parses its result. */
  async request<S extends z.ZodType>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    schema: S,
    opts: SessionRequestOptions = {},
  ): Promise<z.output<S>> {
    return this.client.request(
      {
        method,
        params: {
          ...params,
        },
      },
      schema,
      {
        ...(opts.signal === undefined
          ? {}
          : {
              signal: opts.signal,
            }),
        timeout: opts.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      },
    );
  }

  /** @public Subscribes to a notification method; returns the unsubscribe. */
  on(method: string, handler: NotificationHandler): () => void {
    let set = this.handlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** @public Lists everything the server serves, within the discovery budget. */
  async listServed(signal: AbortSignal): Promise<ServedParts> {
    const work = async (): Promise<ServedParts> => {
      const tools = this.capabilities.tools === undefined ? [] : await this.listTools(signal);
      const declared = hasDeclaration(this.capabilities);
      const resources =
        declared && this.capabilities.resources !== undefined
          ? await this.listResources(signal)
          : [];
      const events =
        declared && this.extension(EVENTS_EXTENSION) !== undefined
          ? await this.listEvents(signal)
          : [];
      return {
        tools,
        resources,
        events,
      };
    };
    return withDeadline(
      work(),
      this.options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
      'Capability discovery',
    );
  }

  /** @public Closes the session. Idempotent. */
  async close(reason = 'released'): Promise<void> {
    this.markClosed(reason);
    await this.client.close().catch(() => {});
  }

  private markClosed(reason: string): void {
    if (this.closeReason !== undefined) {
      return;
    }
    this.closeReason = reason;
    this.settleClosed({
      reason,
    });
  }

  private dispatch(method: string, params: unknown): void {
    const set = this.handlers.get(method);
    if (set === undefined) {
      return;
    }
    const record = isRecord(params) ? params : {};
    for (const handler of [
      ...set,
    ]) {
      handler(record);
    }
  }

  private async paginate<
    S extends z.ZodType<{
      nextCursor?: string | undefined;
    }>,
    T,
  >(
    method: string,
    schema: S,
    pick: (page: z.output<S>) => ReadonlyArray<T>,
    signal: AbortSignal,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.request(method, cursorParams(cursor), schema, {
        signal,
      });
      out.push(...pick(result));
      cursor = result.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }
    return out;
  }

  private listTools(signal: AbortSignal): Promise<ToolInfo[]> {
    return this.paginate(McpMethod.ToolsList, ToolListSchema, (page) => page.tools, signal);
  }

  private listResources(signal: AbortSignal): Promise<ResourceInfo[]> {
    return this.paginate(
      McpMethod.ResourcesList,
      ResourceListSchema,
      (page) => page.resources,
      signal,
    );
  }

  private listEvents(signal: AbortSignal): Promise<EventInfo[]> {
    return this.paginate(McpMethod.EventsList, EventListSchema, (page) => page.events, signal);
  }
}

function cursorParams(cursor: string | undefined): Record<string, unknown> {
  return cursor === undefined
    ? {}
    : {
        cursor,
      };
}

//#endregion
