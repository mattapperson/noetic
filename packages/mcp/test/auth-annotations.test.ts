import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Connection, ConnectOptions } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import type { McpFetch } from '../src/config';
import { mcp } from '../src/provider';
import { originAwareFetch } from '../src/transports';
import { ToolInfoSchema } from '../src/wire';
import { connectOptions, TestServer, textResult } from './_helpers';
import { kiosk, kioskServerOptions, kioskState, ui } from './_profiles';

const opened: Connection[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.release()));
});

//#region Fixtures

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly tenant: string | null;
}

/** Answers one MCP request with a fresh stateless server serving `echo`. */
async function serveMcp(request: Request): Promise<Response> {
  const server = new Server(
    {
      name: 'http-fixture',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => textResult('ok'));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/**
 * A network of fake origins: `routes` maps a URL to a handler; everything is
 * recorded. Unknown URLs are 404s.
 */
function network(routes: Record<string, (request: Request) => Response | Promise<Response>>): {
  readonly fetch: McpFetch;
  readonly seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const request = new Request(String(input), init);
      const headers = new Headers(init?.headers);
      seen.push({
        url: request.url,
        method: request.method,
        authorization: headers.get('authorization'),
        tenant: headers.get('x-tenant'),
      });
      const route = routes[request.url];
      return route === undefined
        ? new Response('not found', {
            status: 404,
          })
        : route(request);
    },
  };
}

function redirectTo(location: string): () => Response {
  return () =>
    new Response(null, {
      status: 307,
      headers: {
        location,
      },
    });
}

function recordingOptions(name: string): ConnectOptions & {
  readonly redacted: string[];
} {
  const redacted: string[] = [];
  return {
    ...connectOptions(name),
    redacted,
    redact: (value) => {
      redacted.push(value);
    },
  };
}

async function connectOne(
  provider: ReturnType<typeof mcp>,
  options: ConnectOptions,
): Promise<Connection> {
  const [connection] = await provider.connect(options);
  assert(connection !== undefined);
  opened.push(connection);
  return connection;
}

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected a throw');
  } catch (error) {
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('CONNECTION_INVALID');
  }
}

//#endregion

describe('auth: bearer', () => {
  it('sends the token to the server origin, keeps it on same-origin redirects, and registers it for scrubbing', async () => {
    const net = network({
      'https://a.test/mcp': redirectTo('https://a.test/v2/mcp'),
      'https://a.test/v2/mcp': serveMcp,
    });
    const options = recordingOptions('bearer');
    const connection = await connectOne(
      mcp({
        type: 'http',
        url: 'https://a.test/mcp',
        auth: {
          kind: 'bearer',
          token: 'tok-123',
        },
        fetch: net.fetch,
      }),
      options,
    );
    expect(Object.keys(connection.manifest.operations)).toEqual([
      'echo',
    ]);
    const posts = net.seen.filter((r) => r.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    for (const request of posts) {
      expect(request.authorization).toBe('Bearer tok-123');
    }
    expect(posts.some((r) => r.url === 'https://a.test/v2/mcp')).toBe(true);
    expect(options.redacted).toEqual([
      'tok-123',
    ]);
  });

  it('strips the token when a redirect leaves the origin', async () => {
    const net = network({
      'https://a.test/mcp': redirectTo('https://b.test/mcp'),
      'https://b.test/mcp': serveMcp,
    });
    await connectOne(
      mcp({
        type: 'http',
        url: 'https://a.test/mcp',
        auth: {
          kind: 'bearer',
          token: 'tok-123',
        },
        fetch: net.fetch,
      }),
      connectOptions('bearer'),
    );
    const atA = net.seen.filter((r) => r.url.startsWith('https://a.test/') && r.method === 'POST');
    const atB = net.seen.filter((r) => r.url.startsWith('https://b.test/'));
    expect(atA.length).toBeGreaterThan(0);
    expect(atB.length).toBeGreaterThan(0);
    expect(atA.every((r) => r.authorization === 'Bearer tok-123')).toBe(true);
    expect(atB.every((r) => r.authorization === null)).toBe(true);
  });

  it('refuses an empty token, a non-provider and auth together with an Authorization header', () => {
    expectInvalid(() =>
      mcp({
        type: 'http',
        url: 'https://a.test/mcp',
        auth: {
          kind: 'bearer',
          token: '',
        },
      }),
    );
    expectInvalid(() =>
      // @ts-expect-error -- not an OAuthClientProvider
      mcp({
        type: 'http',
        url: 'https://a.test/mcp',
        auth: {
          kind: 'oauth',
          provider: {},
        },
      }),
    );
    expectInvalid(() =>
      mcp({
        type: 'http',
        url: 'https://a.test/mcp',
        headers: [
          {
            name: 'authorization',
            value: 'Bearer x',
          },
        ],
        auth: {
          kind: 'bearer',
          token: 'tok',
        },
      }),
    );
  });
});

describe('auth: oauth', () => {
  it('runs the provider on a 401: refreshes, saves and sends the new token, and scrubs both', async () => {
    const saved: OAuthTokens[] = [];
    let current: OAuthTokens = {
      access_token: 'old-token',
      token_type: 'bearer',
      refresh_token: 'refresh-1',
    };
    const client: OAuthClientInformationMixed = {
      client_id: 'noetic',
    };
    const provider = {
      get redirectUrl(): string {
        return 'https://app.test/callback';
      },
      get clientMetadata(): {
        redirect_uris: string[];
      } {
        return {
          redirect_uris: [
            'https://app.test/callback',
          ],
        };
      },
      clientInformation: (): OAuthClientInformationMixed => client,
      tokens: (): OAuthTokens => current,
      saveTokens: (tokens: OAuthTokens): void => {
        saved.push(tokens);
        current = tokens;
      },
      redirectToAuthorization: (): void => {
        throw new Error('no interactive sign-in in this test');
      },
      saveCodeVerifier: (): void => {},
      codeVerifier: (): string => 'verifier',
    };
    const net = network({
      'https://a.test/mcp': (request) =>
        request.headers.get('authorization') === 'Bearer new-token'
          ? serveMcp(request)
          : new Response('unauthorized', {
              status: 401,
              headers: {
                'www-authenticate':
                  'Bearer resource_metadata="https://a.test/.well-known/oauth-protected-resource/mcp"',
              },
            }),
      'https://a.test/.well-known/oauth-protected-resource/mcp': () =>
        Response.json({
          resource: 'https://a.test/mcp',
          authorization_servers: [
            'https://auth.test',
          ],
        }),
      'https://auth.test/.well-known/oauth-authorization-server': () =>
        Response.json({
          issuer: 'https://auth.test',
          authorization_endpoint: 'https://auth.test/authorize',
          token_endpoint: 'https://auth.test/token',
          response_types_supported: [
            'code',
          ],
          grant_types_supported: [
            'authorization_code',
            'refresh_token',
          ],
          code_challenge_methods_supported: [
            'S256',
          ],
          token_endpoint_auth_methods_supported: [
            'none',
          ],
        }),
      'https://auth.test/token': () =>
        Response.json({
          access_token: 'new-token',
          token_type: 'bearer',
        }),
    });
    const options = recordingOptions('oauth');
    const connection = await connectOne(
      mcp({
        type: 'http',
        url: 'https://a.test/mcp',
        headers: [
          {
            name: 'X-Tenant',
            value: 'acme',
          },
        ],
        auth: {
          kind: 'oauth',
          provider,
        },
        fetch: net.fetch,
      }),
      options,
    );
    expect(Object.keys(connection.manifest.operations)).toEqual([
      'echo',
    ]);
    expect(saved.map((t) => t.access_token)).toEqual([
      'new-token',
    ]);
    const mcpPosts = net.seen.filter((r) => r.url === 'https://a.test/mcp' && r.method === 'POST');
    expect(mcpPosts[0]?.authorization).toBe('Bearer old-token');
    expect(mcpPosts.at(-1)?.authorization).toBe('Bearer new-token');
    expect(net.seen.some((r) => r.url === 'https://auth.test/token')).toBe(true);
    // Configured headers never reach the authorization server's origin.
    const atAuth = net.seen.filter((r) => r.url.startsWith('https://auth.test/'));
    expect(atAuth.length).toBeGreaterThan(0);
    expect(atAuth.every((r) => r.tenant === null)).toBe(true);
    expect(options.redacted).toContain('old-token');
    expect(options.redacted).toContain('refresh-1');
    expect(options.redacted).toContain('new-token');
  });
});

describe('originAwareFetch with a home origin', () => {
  it('drops configured headers from requests sent straight to another origin, keeping the request’s own Authorization', async () => {
    const net = network({
      'https://a.test/mcp': () => new Response('ok'),
      'https://auth.test/token': () => new Response('ok'),
    });
    const guarded = originAwareFetch(
      {
        'X-Tenant': 'acme',
      },
      net.fetch,
      'https://a.test/mcp',
    );
    await guarded('https://a.test/mcp', {
      headers: {
        'X-Tenant': 'acme',
      },
    });
    await guarded('https://auth.test/token', {
      headers: {
        'X-Tenant': 'acme',
        Authorization: 'Basic abc',
      },
    });
    expect(net.seen.map((r) => r.tenant)).toEqual([
      'acme',
      null,
    ]);
    expect(net.seen[1]?.authorization).toBe('Basic abc');
  });
});

describe('annotations', () => {
  it('carries MCP tool annotations onto ConnectionOperationInfo for a server with no profile', async () => {
    const fixture = new TestServer({
      tools: [
        {
          name: 'list_issues',
          annotations: {
            title: 'List issues',
            readOnlyHint: true,
            openWorldHint: false,
          },
          handler: () => textResult('[]'),
        },
        {
          name: 'delete_issue',
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
          },
          handler: () => textResult('gone'),
        },
        {
          name: 'plain',
          handler: () => textResult('plain'),
        },
      ],
    });
    const connection = await connectOne(fixture.provider(), connectOptions('linear'));
    const ops = connection.manifest.operations;
    expect(ops.list_issues?.annotations).toEqual({
      title: 'List issues',
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(ops.delete_issue?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(ops.plain).toBeDefined();
    expect(ops.plain?.annotations).toBeUndefined();
  });

  it('carries them onto profile operations of a declaring server', async () => {
    const state = kioskState();
    const options = kioskServerOptions(state);
    const fixture = new TestServer({
      ...options,
      tools: (options.tools ?? []).map((tool) =>
        tool.name === 'ui.tap'
          ? {
              ...tool,
              annotations: {
                destructiveHint: false,
              },
            }
          : tool,
      ),
    });
    const connection = await connectOne(
      fixture.provider({
        profiles: [
          kiosk,
          ui,
        ],
      }),
      connectOptions('kiosk'),
    );
    expect(connection.manifest.operations['ui.tap']?.annotations).toEqual({
      destructiveHint: false,
    });
  });

  it('drops a malformed hint instead of the tool', () => {
    const parsed = ToolInfoSchema.parse({
      name: 'x',
      inputSchema: {
        type: 'object',
      },
      annotations: {
        readOnlyHint: 'yes',
        destructiveHint: true,
      },
    });
    expect(parsed.annotations?.readOnlyHint).toBeUndefined();
    expect(parsed.annotations?.destructiveHint).toBe(true);
    const broken = ToolInfoSchema.parse({
      name: 'y',
      inputSchema: {
        type: 'object',
      },
      annotations: 'nope',
    });
    expect(broken.annotations).toBeUndefined();
  });
});
