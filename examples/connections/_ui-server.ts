/**
 * A real MCP server, spoken over stdio, that implements the `ui@1` profile
 * (spec 36 § Catalog v1) for a tiny login page and declares it under
 * `tools.noetic/profiles` (spec 36 § Declaring a server). The QA scripts in
 * this directory launch it as a subprocess through `mcp()`.
 *
 * The page: textbox "Email", textbox "Password", button "Sign in" and button
 * "Help". After a tap on "Sign in" the page shows heading "Welcome". The
 * locator `button` alone is ambiguous and is refused, never guessed.
 *
 * Environment:
 * - `UI_SERVER_INSTANCE` — the identity instance (default `ui-<pid>`).
 * - `UI_SERVER_LOG` — a file every tool call is appended to as a JSON line,
 *   so a script can check what reached the server (secrets, idempotency keys).
 * - `UI_SERVER_DETERMINISM` — `free` (default), `costly` or `unsafe`.
 * - `UI_SERVER_SLOW_TAP_MS` — delays `ui.tap` so a script can kill the run mid-call.
 * - `UI_SERVER_SENSITIVE_SCHEMA` — `1` publishes `text` as a sensitive field.
 *
 * Run alone: `bun examples/connections/_ui-server.ts` (it waits on stdin).
 */

import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { Server } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { StdioServerTransport } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

//#region Types

type JsonRecord = Record<string, unknown>;

interface ToolResult {
  [key: string]: unknown;
  content: Array<{
    type: 'text';
    text: string;
  }>;
  structuredContent?: JsonRecord;
  isError?: boolean;
}

interface PageElement {
  readonly id: string;
  readonly role: string;
  readonly name: string;
  value: string;
}

type ToolHandler = (args: JsonRecord, meta: JsonRecord) => ToolResult | Promise<ToolResult>;

interface ToolSpec {
  readonly name: string;
  readonly inputSchema: JsonRecord;
  readonly handler: ToolHandler;
}

//#endregion

//#region State

const INSTANCE = process.env.UI_SERVER_INSTANCE ?? `ui-${process.pid}`;
const LOG = process.env.UI_SERVER_LOG;
const REPLAY = process.env.UI_SERVER_DETERMINISM ?? 'free';
const SLOW_TAP_MS = Number(process.env.UI_SERVER_SLOW_TAP_MS ?? '0');

const elements: PageElement[] = [
  {
    id: 'e1',
    role: 'textbox',
    name: 'Email',
    value: '',
  },
  {
    id: 'e2',
    role: 'textbox',
    name: 'Password',
    value: '',
  },
  {
    id: 'e3',
    role: 'button',
    name: 'Sign in',
    value: '',
  },
  {
    id: 'e4',
    role: 'button',
    name: 'Help',
    value: '',
  },
];

let signedIn = false;
let actions = 0;
let epoch = 0;
const seenKeys = new Map<string, ToolResult>();
const subscriptions = new Map<string, string>();
let nextSubscription = 1;

//#endregion

//#region Helpers

function log(entry: JsonRecord): void {
  if (LOG === undefined) {
    return;
  }
  appendFileSync(
    LOG,
    `${JSON.stringify({
      instance: INSTANCE,
      ...entry,
    })}\n`,
  );
}

function structured(value: JsonRecord): ToolResult {
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

function refusal(code: string, message: string, details?: JsonRecord): ToolResult {
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

function elementRef(el: PageElement): JsonRecord {
  return {
    $ref: {
      kind: 'ui.element',
      id: el.id,
    },
  };
}

function visible(): PageElement[] {
  if (!signedIn) {
    return elements;
  }
  return [
    ...elements,
    {
      id: 'e5',
      role: 'heading',
      name: 'Welcome',
      value: '',
    },
  ];
}

function node(el: PageElement): JsonRecord {
  return {
    element: elementRef(el),
    role: el.role,
    name: el.name,
    ...(el.value === ''
      ? {}
      : {
          value: el.value,
        }),
  };
}

function tree(): JsonRecord {
  return {
    element: {
      $ref: {
        kind: 'ui.element',
        id: 'root',
      },
    },
    role: 'document',
    name: 'Login',
    children: visible().map(node),
  };
}

/** Resolves a target to exactly one element, or refuses (spec 36 § Errors). */
function resolve(target: unknown): PageElement | ToolResult {
  if (typeof target === 'object' && target !== null && '$ref' in target) {
    const body = z
      .object({
        $ref: z.object({
          id: z.string(),
        }),
      })
      .safeParse(target);
    const found = body.success ? visible().find((e) => e.id === body.data.$ref.id) : undefined;
    return found ?? refusal('stale_reference', 'That element is gone.');
  }
  if (typeof target !== 'string' || target.length === 0) {
    return refusal('malformed', 'element is required.');
  }
  const match = /^(\w+)(?:\s+"([^"]*)")?$/.exec(target);
  if (match === null) {
    return refusal('malformed', `Not a locator: ${target}`);
  }
  const [, role, name] = match;
  const hits = visible().filter((e) => e.role === role && (name === undefined || e.name === name));
  if (hits.length === 0) {
    return refusal('unresolved', `Nothing matches ${target}.`);
  }
  if (hits.length > 1) {
    return refusal('ambiguous', `${hits.length} elements match ${target}.`, {
      candidates: hits.map((h) => `${h.role} "${h.name}"`),
    });
  }
  const [hit] = hits;
  return hit ?? refusal('unresolved', `Nothing matches ${target}.`);
}

function isRefusal(value: PageElement | ToolResult): value is ToolResult {
  return 'content' in value;
}

async function changed(server: Server, actionId: string, summary: string): Promise<void> {
  for (const [id, name] of subscriptions) {
    if (name !== 'ui.changed') {
      continue;
    }
    await server.notification({
      method: 'notifications/events/event',
      params: {
        subscriptionId: id,
        eventId: `ev-${actionId}`,
        name: 'ui.changed',
        timestamp: new Date().toISOString(),
        data: {
          summary,
        },
        cursor: `c${actions}`,
        actionId,
      },
    });
  }
}

function receipt(): JsonRecord {
  actions++;
  return {
    actionId: `${INSTANCE}-a${actions}`,
    cursor: `c${actions}`,
  };
}

//#endregion

//#region Tools

/**
 * With `UI_SERVER_SENSITIVE_SCHEMA=1` the server publishes `text` the way a
 * profile's `sensitive()` field is published (`anyOf: [string, { $secret }]`).
 */
const TEXT_SCHEMA =
  process.env.UI_SERVER_SENSITIVE_SCHEMA === '1'
    ? {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'object',
            properties: {
              $secret: {
                type: 'string',
              },
            },
            required: [
              '$secret',
            ],
          },
        ],
      }
    : {
        type: 'string',
      };

const ELEMENT_INPUT = {
  type: 'object',
  properties: {
    element: {},
    text: TEXT_SCHEMA,
    count: {
      type: 'integer',
    },
  },
  required: [
    'element',
  ],
};

function buildTools(server: Server): ToolSpec[] {
  const write = (append: boolean): ToolHandler => {
    return async (args) => {
      const el = resolve(args.element);
      if (isRefusal(el)) {
        return el;
      }
      if (el.role !== 'textbox') {
        return refusal('unsupported', `${el.role} "${el.name}" does not take text.`);
      }
      const text = typeof args.text === 'string' ? args.text : '';
      el.value = append ? el.value + text : text;
      const r = receipt();
      await changed(server, String(r.actionId), `textbox "${el.name}"`);
      return structured({
        receipt: r,
      });
    };
  };
  return [
    {
      name: 'ui.find',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
          },
          within: {},
        },
        required: [
          'query',
        ],
      },
      handler: (args) => {
        const query = String(args.query).toLowerCase();
        return structured({
          elements: visible()
            .filter((e) => `${e.role} "${e.name}"`.toLowerCase().includes(query))
            .map((e) => ({
              element: elementRef(e),
              role: e.role,
              name: e.name,
            })),
        });
      },
    },
    {
      name: 'ui.describe',
      inputSchema: {
        type: 'object',
        properties: {
          element: {},
          within: {},
          full: {
            type: 'boolean',
          },
        },
      },
      handler: () =>
        structured({
          tree: tree(),
        }),
    },
    {
      name: 'ui.tap',
      inputSchema: ELEMENT_INPUT,
      handler: async (args) => {
        const el = resolve(args.element);
        if (isRefusal(el)) {
          return el;
        }
        if (SLOW_TAP_MS > 0) {
          await new Promise((r) => setTimeout(r, SLOW_TAP_MS));
        }
        if (el.name === 'Sign in') {
          signedIn = true;
        }
        const r = receipt();
        await changed(
          server,
          String(r.actionId),
          signedIn ? 'heading "Welcome"' : `button "${el.name}"`,
        );
        return structured({
          receipt: r,
        });
      },
    },
    {
      name: 'ui.fill',
      inputSchema: ELEMENT_INPUT,
      handler: write(false),
    },
    {
      name: 'ui.type',
      inputSchema: ELEMENT_INPUT,
      handler: write(true),
    },
    {
      name: 'ui.key',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
          },
          modifiers: {},
          element: {},
        },
        required: [
          'key',
        ],
      },
      handler: () =>
        structured({
          receipt: receipt(),
        }),
    },
    {
      name: 'ui.scroll',
      inputSchema: {
        type: 'object',
        properties: {
          element: {},
          within: {},
          direction: {
            type: 'string',
          },
          amount: {
            type: 'number',
          },
        },
        required: [
          'direction',
        ],
      },
      handler: () =>
        structured({
          receipt: receipt(),
        }),
    },
    {
      name: 'ui.settle',
      inputSchema: {
        type: 'object',
        properties: {
          until: {
            type: 'string',
          },
          event: {
            type: 'string',
          },
          quietMs: {
            type: 'number',
          },
          after: {},
          timeoutMs: {
            type: 'number',
          },
        },
        required: [
          'until',
          'timeoutMs',
        ],
      },
      handler: async (args) => {
        await new Promise((r) => setTimeout(r, Math.min(Number(args.quietMs ?? 20), 200)));
        return structured({
          closedBy: 'quiescence',
        });
      },
    },
    {
      name: 'noetic.reset',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: () => {
        signedIn = false;
        for (const el of elements) {
          el.value = '';
        }
        epoch++;
        return structured({});
      },
    },
  ];
}

//#endregion

//#region Server

function declaration(): JsonRecord {
  return {
    profiles: {
      ui: '1.0.0',
    },
    senses: {
      ui: {
        independence: 'actuation-derived',
        grade: 'presence',
      },
      time: {
        independence: 'actuation-derived',
        grade: 'context',
      },
    },
    determinism: {
      reset: REPLAY === 'unsafe' ? 'none' : 'cheap',
      replayPrefix: REPLAY,
      time: 'wall',
      observation: 'exact',
      actions: REPLAY === 'unsafe' ? 'irreversible' : 'reversible',
    },
  };
}

function method<M extends string>(name: M) {
  return z.object({
    method: z.literal(name),
    params: z.looseObject({}).optional(),
  });
}

function build(): Server {
  const server = new Server(
    {
      name: 'qa-ui-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        extensions: {
          'tools.noetic/profiles': declaration(),
          'io.modelcontextprotocol/events': {
            delivery: [
              'push',
            ],
          },
        },
      },
    },
  );
  const tools = buildTools(server);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      inputSchema: t.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const meta = request.params._meta ?? {};
    log({
      tool: name,
      args,
      meta,
    });
    const key = meta['tools.noetic/idempotency-key'];
    if (typeof key === 'string' && seenKeys.has(key)) {
      const prior = seenKeys.get(key);
      if (prior !== undefined) {
        return prior;
      }
    }
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) {
      return refusal('undeclared', `No tool ${name}.`);
    }
    const result = await tool.handler(args, meta);
    if (typeof key === 'string' && result.isError !== true) {
      seenKeys.set(key, result);
    }
    return result;
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'noetic://identity',
        name: 'identity',
        mimeType: 'application/json',
      },
      {
        uri: 'noetic://read/ui.summary',
        name: 'ui.summary',
        mimeType: 'application/json',
      },
      {
        uri: 'noetic://read/ui.tree',
        name: 'ui.tree',
        mimeType: 'application/json',
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const bodies: Record<string, () => unknown> = {
      'noetic://identity': () => ({
        surface: 'x-qa-ui',
        instance: INSTANCE,
        epoch,
      }),
      'noetic://read/ui.summary': () => ({
        focused: null,
        counts: visible().reduce<Record<string, number>>((acc, e) => {
          acc[e.role] = (acc[e.role] ?? 0) + 1;
          return acc;
        }, {}),
      }),
      'noetic://read/ui.tree': () => tree(),
    };
    const body = bodies[uri];
    if (body === undefined) {
      throw new Error(`no resource ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(body()),
        },
      ],
    };
  });
  server.setRequestHandler(method('events/list'), async () => ({
    events: [
      {
        name: 'ui.changed',
        replay: 'live',
      },
      {
        name: 'identity.changed',
      },
    ],
  }));
  server.setRequestHandler(method('events/stream'), async (request) => {
    const id = `sub-${nextSubscription++}`;
    subscriptions.set(id, String(request.params?.name));
    return {
      subscriptionId: id,
      cursor: `c${actions}`,
    };
  });
  server.setRequestHandler(method('events/unsubscribe'), async (request) => {
    subscriptions.delete(String(request.params?.subscriptionId));
    return {};
  });
  return server;
}

await build().connect(new StdioServerTransport());

//#endregion
