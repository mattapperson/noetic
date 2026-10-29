/**
 * An in-process MCP server built with the SDK's low-level `Server`, reached
 * over `InMemoryTransport` (no network, no subprocess). Each MCP session gets
 * its own `Server` instance; state shared across sessions lives on the
 * returned fixture so tests can drive events, tasks and identity changes.
 */

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Notification, Request, Result } from '@modelcontextprotocol/sdk/types.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ConnectOptions } from '@noetic-tools/types';
import { PROFILES_CAPABILITY } from '@noetic-tools/types';
import { z } from 'zod';
import type { McpOptions } from '../src/config';
import { createMemoryArtifactStore } from '../src/memory-artifacts';
import type { McpProvider } from '../src/provider';
import { mcp } from '../src/provider';
import { EVENTS_EXTENSION, TASKS_EXTENSION } from '../src/wire';

//#region Types

export type ToolHandler = (
  args: Record<string, unknown>,
  meta: Record<string, unknown>,
) => Result | Promise<Result>;

export interface TestTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  taskSupport?: 'required' | 'optional';
  handler: ToolHandler;
}

export interface TestResource {
  uri: string;
  name: string;
  mimeType?: string;
  read: (meta: Record<string, unknown>) => {
    text?: string;
    blob?: string;
    mimeType?: string;
  };
}

export interface TestEventType {
  name: string;
  replay?: 'durable' | 'live' | 'none';
  sense?: string;
  thread?: string;
}

export interface WireEventInput {
  eventId: string;
  name: string;
  data: unknown;
  cursor?: string;
  actionId?: string;
  timestamp?: string;
}

export interface TestServerOptions {
  declaration?: unknown;
  tools?: TestTool[];
  resources?: TestResource[];
  events?: TestEventType[];
  delivery?: Array<'push' | 'webhook' | 'poll'>;
  tasks?: boolean;
  /** Extra capability entries. */
  capabilities?: Record<string, unknown>;
}

export interface TaskRecord {
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  statusMessage?: string;
  progress?: {
    current: number;
    total?: number;
  };
  inputRequests?: Record<
    string,
    {
      message: string;
    }
  >;
  result?: Result;
  error?: {
    code?: string;
    message: string;
  };
  responses: Record<string, unknown>[];
}

interface Subscription {
  id: string;
  name: string;
  server: Server<Request, Notification, Result>;
  delivery: 'push' | 'webhook';
  url?: string;
  secret?: string;
  arguments?: unknown;
}

//#endregion

//#region Fixture

export class TestServer {
  readonly options: TestServerOptions;
  readonly servers: Server<Request, Notification, Result>[] = [];
  readonly tasks = new Map<string, TaskRecord>();
  readonly subscriptions = new Map<string, Subscription>();
  readonly unsubscribed: string[] = [];
  readonly calls: Array<{
    name: string;
    args: Record<string, unknown>;
    meta: Record<string, unknown>;
  }> = [];
  readonly polled: Array<{
    name: string;
    cursor: unknown;
  }> = [];
  /** Events waiting for the next poll. */
  pollQueue: WireEventInput[] = [];
  pollTerminated: string | undefined;
  tools: TestTool[];
  /** Webhook deliveries go here when a subscription uses a webhook. */
  webhookSink?: (sub: Subscription, body: Record<string, unknown>) => Promise<void>;
  private nextSubscription = 1;

  constructor(options: TestServerOptions) {
    this.options = options;
    this.tools = options.tools ?? [];
  }

  /** A provider whose sessions each get a fresh in-process server. */
  provider(options: McpOptions = {}): McpProvider {
    return mcp(
      {
        transport: async () => {
          const [client, serverSide] = InMemoryTransport.createLinkedPair();
          const server = this.build();
          this.servers.push(server);
          await server.connect(serverSide);
          return client;
        },
      },
      {
        pollIntervalMs: 10,
        ...options,
      },
    );
  }

  /** Sends one event to every push subscriber for its name, and queues it for pollers. */
  async emit(event: WireEventInput): Promise<void> {
    const wire = {
      timestamp: new Date(0).toISOString(),
      ...event,
    };
    this.pollQueue.push(wire);
    for (const sub of this.subscriptions.values()) {
      if (sub.name !== event.name) {
        continue;
      }
      await this.deliver(sub, 'event', wire);
    }
  }

  async gap(name: string, reason: string): Promise<void> {
    for (const sub of this.subscriptions.values()) {
      if (sub.name === name) {
        await this.deliver(sub, 'gap', {
          reason,
        });
      }
    }
  }

  async terminate(name: string, reason: string): Promise<void> {
    for (const sub of this.subscriptions.values()) {
      if (sub.name === name) {
        await this.deliver(sub, 'terminated', {
          reason,
        });
      }
    }
  }

  async notifyAll(method: string, params: Record<string, unknown> = {}): Promise<void> {
    for (const server of this.servers) {
      await server.notification({
        method,
        params,
      });
    }
  }

  private async deliver(
    sub: Subscription,
    type: 'event' | 'gap' | 'terminated',
    body: Record<string, unknown>,
  ): Promise<void> {
    if (sub.delivery === 'webhook') {
      await this.webhookSink?.(sub, {
        type,
        subscriptionId: sub.id,
        ...body,
      });
      return;
    }
    await sub.server.notification({
      method: `notifications/events/${type}`,
      params: {
        subscriptionId: sub.id,
        ...body,
      },
    });
  }

  private capabilities(): Record<string, unknown> {
    const extensions: Record<string, unknown> = {};
    if (this.options.declaration !== undefined) {
      extensions[PROFILES_CAPABILITY] = this.options.declaration;
    }
    if (this.options.events !== undefined) {
      extensions[EVENTS_EXTENSION] =
        this.options.delivery === undefined
          ? {}
          : {
              delivery: this.options.delivery,
            };
    }
    if (this.options.tasks === true) {
      extensions[TASKS_EXTENSION] = {};
    }
    return {
      tools: {
        listChanged: true,
      },
      ...(this.options.resources === undefined
        ? {}
        : {
            resources: {
              listChanged: true,
            },
          }),
      ...(this.options.tasks === true
        ? {
            tasks: {
              requests: {
                tools: {
                  call: {},
                },
              },
            },
          }
        : {}),
      extensions,
      ...(this.options.capabilities ?? {}),
    };
  }

  private build(): Server<Request, Notification, Result> {
    const server = new Server<Request, Notification, Result>(
      {
        name: 'test-server',
        version: '1.0.0',
      },
      {
        capabilities: this.capabilities(),
      },
    );
    this.registerTools(server);
    this.registerResources(server);
    this.registerEvents(server);
    this.registerTasks(server);
    return server;
  }

  private registerTools(server: Server<Request, Notification, Result>): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined
          ? {}
          : {
              description: tool.description,
            }),
        inputSchema: tool.inputSchema ?? {
          type: 'object',
          properties: {},
        },
        ...(tool.taskSupport === undefined
          ? {}
          : {
              execution: {
                taskSupport: tool.taskSupport,
              },
            }),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const meta = request.params._meta ?? {};
      this.calls.push({
        name,
        args,
        meta,
      });
      const tool = this.tools.find((t) => t.name === name);
      if (tool === undefined) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `undeclared: ${name}`,
            },
          ],
          structuredContent: {
            code: 'undeclared',
            message: `no tool ${name}`,
          },
        };
      }
      return tool.handler(args, meta);
    });
  }

  private registerResources(server: Server<Request, Notification, Result>): void {
    const resources = this.options.resources;
    if (resources === undefined) {
      return;
    }
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        ...(r.mimeType === undefined
          ? {}
          : {
              mimeType: r.mimeType,
            }),
      })),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const resource = resources.find((r) => uri === r.uri || uri.startsWith(`${r.uri}?`));
      if (resource === undefined) {
        throw new Error(`no resource ${uri}`);
      }
      const content = resource.read(request.params._meta ?? {});
      return {
        contents: [
          {
            uri,
            mimeType: content.mimeType ?? resource.mimeType ?? 'application/json',
            ...content,
          },
        ],
      };
    });
  }

  private registerEvents(server: Server<Request, Notification, Result>): void {
    const events = this.options.events;
    if (events === undefined) {
      return;
    }
    server.setRequestHandler(method('events/list'), async () => ({
      events,
    }));
    server.setRequestHandler(method('events/stream'), async (request) => {
      const id = `sub-${this.nextSubscription++}`;
      this.subscriptions.set(id, {
        id,
        name: String(request.params?.name),
        server,
        delivery: 'push',
        arguments: request.params?.arguments,
      });
      return {
        subscriptionId: id,
        cursor: 'c0',
      };
    });
    server.setRequestHandler(method('events/subscribe'), async (request) => {
      const id = `sub-${this.nextSubscription++}`;
      const delivery = z
        .object({
          url: z.string(),
          secret: z.string(),
        })
        .parse(request.params?.delivery);
      this.subscriptions.set(id, {
        id,
        name: String(request.params?.name),
        server,
        delivery: 'webhook',
        url: delivery.url,
        secret: delivery.secret,
      });
      return {
        subscriptionId: id,
        cursor: 'c0',
      };
    });
    server.setRequestHandler(method('events/unsubscribe'), async (request) => {
      const id = String(request.params?.subscriptionId);
      this.subscriptions.delete(id);
      this.unsubscribed.push(id);
      return {};
    });
    server.setRequestHandler(method('events/poll'), async (request) => {
      this.polled.push({
        name: String(request.params?.name),
        cursor: request.params?.cursor,
      });
      const name = String(request.params?.name);
      const ready = this.pollQueue.filter((e) => e.name === name);
      this.pollQueue = this.pollQueue.filter((e) => e.name !== name);
      return {
        events: ready.map((e) => ({
          timestamp: new Date(0).toISOString(),
          ...e,
        })),
        cursor:
          ready.at(-1)?.cursor ?? (request.params?.cursor === null ? 'p0' : request.params?.cursor),
        ...(this.pollTerminated === undefined
          ? {}
          : {
              terminated: {
                reason: this.pollTerminated,
              },
            }),
      };
    });
  }

  private registerTasks(server: Server<Request, Notification, Result>): void {
    if (this.options.tasks !== true) {
      return;
    }
    server.setRequestHandler(method('tasks/get'), async (request) => {
      const taskId = String(request.params?.taskId);
      const task = this.tasks.get(taskId);
      if (task === undefined) {
        throw new Error(`no task ${taskId}`);
      }
      const { responses: _responses, ...rest } = task;
      return {
        taskId,
        ...rest,
      };
    });
    server.setRequestHandler(method('tasks/update'), async (request) => {
      const taskId = String(request.params?.taskId);
      const task = this.tasks.get(taskId);
      if (task === undefined) {
        throw new Error(`no task ${taskId}`);
      }
      const responses = z.record(z.string(), z.unknown()).parse(request.params?.inputResponses);
      task.responses.push(responses);
      return {};
    });
    server.setRequestHandler(method('tasks/cancel'), async (request) => {
      const taskId = String(request.params?.taskId);
      const task = this.tasks.get(taskId);
      if (task !== undefined) {
        task.status = 'cancelled';
      }
      return {};
    });
  }
}

function method<M extends string>(name: M) {
  return z.object({
    method: z.literal(name),
    params: z.looseObject({}).optional(),
  });
}

//#endregion

//#region Helpers

/** A `CreateTaskResult` the SDK server accepts. */
export function createdTask(taskId: string): Result {
  const now = new Date(0).toISOString();
  return {
    task: {
      taskId,
      status: 'working',
      ttl: null,
      createdAt: now,
      lastUpdatedAt: now,
    },
  };
}

export function connectOptions(name = 'test'): ConnectOptions {
  return {
    name,
    signal: new AbortController().signal,
    artifacts: createMemoryArtifactStore(),
  };
}

export function textResult(text: string): Result {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

export function structured(value: Record<string, unknown>): Result {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value),
      },
    ],
    structuredContent: value,
  };
}

export function refusal(code: string, message: string, details?: Record<string, unknown>): Result {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    structuredContent: {
      code,
      message,
      ...(details === undefined
        ? {}
        : {
            details,
          }),
    },
  };
}

export function identityResource(identity: () => Record<string, unknown>): TestResource {
  return {
    uri: 'noetic://identity',
    name: 'identity',
    mimeType: 'application/json',
    read: () => ({
      text: JSON.stringify(identity()),
    }),
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2e3): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

//#endregion
