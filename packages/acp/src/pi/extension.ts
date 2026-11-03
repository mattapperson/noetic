/**
 * `pi-noetic-tools` — a pi extension that registers each tool the Noetic
 * bridge serves as a native pi tool, with the same name, description and
 * JSON Schema, and forwards each call to the bridge, returning its text
 * unchanged.
 *
 * pi loads this file into its own process (through jiti), so it imports
 * nothing: it speaks just enough MCP streamable HTTP over `fetch` to list and
 * call tools. It reads the bridge address from the environment and then
 * removes it, so the token never reaches commands pi runs.
 */

//#region Types

/** The part of pi's extension API this uses. */
interface PiExtensionApi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    executionMode?: 'sequential' | 'parallel';
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
    ): Promise<{
      content: Array<{
        type: 'text';
        text: string;
      }>;
      details: unknown;
    }>;
  }): void;
}

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
}

interface JsonRpcReply {
  result?: unknown;
  error?: {
    message?: string;
  };
}

//#endregion

//#region Constants

/** Environment the pi wiring sets: the bridge URL and its headers as JSON pairs. */
const URL_VAR = 'NOETIC_TOOLS_URL';
const HEADERS_VAR = 'NOETIC_TOOLS_HEADERS';
const PROTOCOL_VERSION = '2025-06-18';

//#endregion

//#region Public API

/** Registers the bridged tools before pi's session starts. */
export default async function noeticTools(pi: PiExtensionApi): Promise<void> {
  const url = process.env[URL_VAR];
  if (!url) {
    return;
  }
  const headers = parseHeaders(process.env[HEADERS_VAR]);
  delete process.env[URL_VAR];
  delete process.env[HEADERS_VAR];
  const bridge = new BridgeClient(url, headers);
  await bridge.open();
  for (const tool of await bridge.listTools()) {
    pi.registerTool({
      name: tool.name,
      label: tool.title ?? tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema,
      // The bridge runs calls one at a time, as a `callModel` round does.
      executionMode: 'sequential',
      async execute(toolCallId, params, signal) {
        const text = await bridge.callTool(tool.name, params, toolCallId, signal);
        return {
          content: [
            {
              type: 'text',
              text,
            },
          ],
          details: {},
        };
      },
    });
  }
}

//#endregion

//#region Bridge client

class BridgeClient {
  private session: string | undefined;
  private next = 0;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  async open(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'pi-noetic-tools',
        version: '1.0.0',
      },
    });
    await this.post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = asRecord(
        await this.request(
          'tools/list',
          cursor
            ? {
                cursor,
              }
            : {},
        ),
      );
      tools.push(...(Array.isArray(page.tools) ? page.tools.flatMap(toolOf) : []));
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  /**
   * The result's text, exactly as the bridge gave it. An error result is the
   * same text a `callModel` model would read, so it is returned, not thrown.
   */
  async callTool(
    name: string,
    args: unknown,
    callId: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const result = asRecord(
      await this.request(
        'tools/call',
        {
          name,
          arguments: args ?? {},
          _meta: {
            callId,
          },
        },
        signal,
      ),
    );
    const content = Array.isArray(result.content) ? result.content : [];
    return content
      .map((part: unknown) => {
        const text = asRecord(part).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    this.next += 1;
    const id = this.next;
    const response = await this.post(
      {
        jsonrpc: '2.0',
        id,
        method,
        params,
      },
      signal,
    );
    const reply = await readReply(response, id);
    if (reply.error) {
      throw new Error(`noetic tools: ${method} failed: ${reply.error.message ?? 'unknown error'}`);
    }
    return reply.result;
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(this.session
          ? {
              'Mcp-Session-Id': this.session,
            }
          : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(`noetic tools: the bridge answered HTTP ${response.status}.`);
    }
    this.session = response.headers.get('mcp-session-id') ?? this.session;
    return response;
  }
}

//#endregion

//#region Helpers

/** A JSON reply, or the matching message of an SSE stream. */
async function readReply(response: Response, id: number): Promise<JsonRpcReply> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) {
    return replyOf(await response.json());
  }
  const text = await response.text();
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '') {
      continue;
    }
    const message = asRecord(JSON.parse(data));
    if (message.id === id) {
      return replyOf(message);
    }
  }
  throw new Error('noetic tools: the bridge sent no reply.');
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  const pairs = JSON.parse(raw);
  if (!Array.isArray(pairs)) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const pair of pairs) {
    const entry = asRecord(pair);
    if (typeof entry.name === 'string' && typeof entry.value === 'string') {
      headers[entry.name] = entry.value;
    }
  }
  return headers;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function toolOf(value: unknown): McpTool[] {
  const tool = asRecord(value);
  if (typeof tool.name !== 'string') {
    return [];
  }
  return [
    {
      name: tool.name,
      title: typeof tool.title === 'string' ? tool.title : undefined,
      description: typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: tool.inputSchema,
    },
  ];
}

function replyOf(value: unknown): JsonRpcReply {
  const message = asRecord(value);
  const error = message.error === undefined ? undefined : asRecord(message.error);
  return {
    result: message.result,
    error: error && {
      message: typeof error.message === 'string' ? error.message : undefined,
    },
  };
}

//#endregion
