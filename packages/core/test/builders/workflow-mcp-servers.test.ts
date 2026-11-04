// The MCP servers a document names (spec 26 § MCP servers): the host's `mcp`
// allowlist, checked by parseAndRunWorkflow and dynamicWorkflow before anything
// runs, `$secret` header and env values, and the connection entry each granted
// server becomes — in a node's `tools` or the document's `connections`.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpAgent,
  AcpMcpServer,
  CallModelRequest,
  ConnectionProvider,
  ConnectOptions,
  Context,
  GrantedMcpServer,
  McpAllowlist,
  SecretResolver,
  Spawn,
  WorkflowDocument,
  WorkflowMcpSecretValue,
  WorkflowMcpServer,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { dynamicWorkflow, parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { checkMcpServers, mcpEntry, mcpPrompt } from '../../src/builders/workflow-mcp-servers';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryArtifactStore } from '../../src/runtime/in-memory-artifact-store';
import { makeLLMResponse, makeMessage } from '../_helpers';

//#region Helpers

const STDIO_TOUCH: WorkflowMcpServer = {
  name: 'evil',
  command: 'touch',
  args: [
    '/tmp/pwned',
  ],
  env: [],
};

const DOCS_SERVER = {
  name: 'docs',
  command: 'npx',
  args: [
    '-y',
    '@acme/docs-mcp',
  ],
  env: [],
} satisfies WorkflowMcpServer;

/** An acp-agent node that lists each server as a `{ "mcp" }` tools entry. */
function agentDoc(servers: WorkflowMcpServer[]): WorkflowDocument {
  return {
    version: 1,
    root: {
      kind: 'acp-agent',
      id: 'agent',
      agent: 'fake',
      prompt: 'do the task',
      tools: servers.map((mcp) => ({
        mcp,
      })),
    },
  };
}

function http(url: string, headers: WorkflowMcpSecretValue[] = []): WorkflowMcpServer {
  return {
    type: 'http',
    name: 'remote',
    url,
    headers,
  };
}

/** An agent that records each connect and the servers each session is created with. */
function recordingAgent(): {
  agent: AcpAgent;
  connects: number;
  sessions: Array<ReadonlyArray<AcpMcpServer> | undefined>;
  /** The bridged tool names each connect served. */
  served: string[][];
} {
  const record = {
    connects: 0,
    sessions: frameworkCast<Array<ReadonlyArray<AcpMcpServer> | undefined>>([]),
    served: frameworkCast<string[][]>([]),
  };
  const agent: AcpAgent = {
    specificationVersion: 'acp-v1',
    agentId: 'fake',
    async connect(opts) {
      record.connects += 1;
      record.served.push((opts.host.tools?.tools ?? []).map((tool) => tool.name));
      return {
        agentCapabilities: {
          mcpCapabilities: {
            http: true,
            sse: true,
          },
        },
        authMethods: [],
        protocolVersion: 1,
        async authenticate() {
          // No auth in the fake.
        },
        async newSession(opts) {
          record.sessions.push(opts.mcpServers);
          return {
            sessionId: 's1',
            availableCommands: [],
            async prompt() {
              return {
                stopReason: 'end_turn',
                items: [
                  makeMessage('assistant', 'agent done'),
                ],
                text: 'agent done',
              };
            },
            async cancel() {
              // Nothing in flight.
            },
            async setMode() {
              // No modes.
            },
            async setModel() {
              // No models.
            },
          };
        },
        async loadSession() {
          throw new Error('not used');
        },
        async close() {
          // Nothing to release.
        },
      };
    },
  };
  return Object.assign(record, {
    agent,
  });
}

function harnessWithSecrets(secrets?: Record<string, string>): AgentHarness {
  return new AgentHarness({
    name: 'mcp-servers',
    params: {},
    ...(secrets
      ? {
          environment: {
            secrets: {
              async resolve(name: string) {
                const value = secrets[name];
                assert(value !== undefined, `unknown secret ${name}`);
                return value;
              },
            },
          },
        }
      : {}),
  });
}

async function runDoc(
  document: WorkflowDocument,
  opts: {
    mcp?: McpAllowlist;
    secrets?: Record<string, string>;
  } = {},
): Promise<{
  output: string;
  ctx: Context;
  record: ReturnType<typeof recordingAgent>;
}> {
  const record = recordingAgent();
  const harness = harnessWithSecrets(opts.secrets);
  const ctx = harness.createContext();
  const output = await parseAndRunWorkflow({
    json: document,
    harness,
    ctx,
    tools: [],
    acpAgents: new Map([
      [
        'fake',
        record.agent,
      ],
    ]),
    mcp: opts.mcp,
  });
  return {
    output,
    ctx,
    record,
  };
}

function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

async function expectConfig(promise: Promise<unknown>, code: string): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const cause = rootCause(e);
    assert(isNoeticConfigError(cause));
    expect(cause.code).toBe(code);
    return cause.message;
  }
  expect.unreachable(`expected ${code}`);
  return '';
}

function expectNotAllowed(document: WorkflowDocument, allowlist: McpAllowlist | undefined): void {
  try {
    checkMcpServers(document, allowlist, SECRETS);
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('CONNECTION_NOT_ALLOWED');
    return;
  }
  expect.unreachable('expected CONNECTION_NOT_ALLOWED');
}

const SECRETS: SecretResolver = {
  async resolve(name) {
    return `resolved-${name}`;
  },
};

const DOCS_GRANT: McpAllowlist = {
  commands: [
    {
      command: 'npx',
      args: [
        '-y',
        '@acme/docs-mcp',
      ],
    },
  ],
};

/** A host `provider` that records each server it is asked to build, and backs it in memory. */
function recordingHost(): {
  readonly provider: (server: GrantedMcpServer) => ConnectionProvider;
  readonly built: GrantedMcpServer[];
} {
  const built: GrantedMcpServer[] = [];
  return {
    built,
    provider: (server) => {
      built.push(server);
      return createInMemoryConnection({
        name: server.name,
        operations: {
          lookup: {
            inputSchema: {
              type: 'object',
            },
            run: () => 'found',
          },
        },
      });
    },
  };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function connectOptions(overrides: Partial<ConnectOptions> = {}): ConnectOptions {
  return {
    name: 'remote',
    signal: new AbortController().signal,
    artifacts: createInMemoryArtifactStore(),
    ...overrides,
  };
}

const SECRET_HEADER: WorkflowMcpSecretValue = {
  name: 'Authorization',
  value: {
    $secret: 'mcp.token',
  },
};

const TOKEN_GRANT: McpAllowlist = {
  urls: [
    {
      url: 'https://mcp.example.com/*',
      secrets: {
        'mcp.token': 'Authorization',
      },
      policy: {
        deny: [
          'delete_*',
        ],
      },
    },
  ],
};

//#endregion

describe('checkMcpServers — stdio', () => {
  it('refuses any stdio server when there is no allowlist', () => {
    expectNotAllowed(
      agentDoc([
        STDIO_TOUCH,
      ]),
      undefined,
    );
  });

  it('refuses a command the allowlist does not name', () => {
    expectNotAllowed(
      agentDoc([
        STDIO_TOUCH,
      ]),
      DOCS_GRANT,
    );
  });

  it('accepts the exact command and args the allowlist names', () => {
    expect(() =>
      checkMcpServers(
        agentDoc([
          DOCS_SERVER,
        ]),
        DOCS_GRANT,
        SECRETS,
      ),
    ).not.toThrow();
  });

  it('refuses the allowed command with an extra, missing or reordered arg', () => {
    for (const args of [
      [
        '-y',
        '@acme/docs-mcp',
        '--evil',
      ],
      [
        '-y',
      ],
      [
        '@acme/docs-mcp',
        '-y',
      ],
    ]) {
      expectNotAllowed(
        agentDoc([
          {
            ...DOCS_SERVER,
            args,
          },
        ]),
        DOCS_GRANT,
      );
    }
  });

  it('refuses a secret bound to another variable, and accepts only the bound secret', () => {
    const grant: McpAllowlist = {
      commands: [
        {
          command: 'npx',
          args: [
            '-y',
            '@acme/docs-mcp',
          ],
          secrets: {
            'docs.token': 'DOCS_TOKEN',
          },
        },
      ],
    };
    expectNotAllowed(
      agentDoc([
        {
          ...DOCS_SERVER,
          env: [
            {
              name: 'NODE_OPTIONS',
              value: {
                $secret: 'docs.token',
              },
            },
          ],
        },
      ]),
      grant,
    );
    expect(() =>
      checkMcpServers(
        agentDoc([
          {
            ...DOCS_SERVER,
            env: [
              {
                name: 'DOCS_TOKEN',
                value: {
                  $secret: 'docs.token',
                },
              },
            ],
          },
        ]),
        grant,
        SECRETS,
      ),
    ).not.toThrow();
  });

  it('checks servers inside an inline subflow', () => {
    expectNotAllowed(
      {
        version: 1,
        root: {
          kind: 'subflow',
          id: 'outer',
          document: agentDoc([
            STDIO_TOUCH,
          ]),
        },
      },
      DOCS_GRANT,
    );
  });
});

describe('checkMcpServers — HTTP and SSE', () => {
  const grant: McpAllowlist = {
    urls: [
      {
        url: 'https://mcp.example.com/*',
        secrets: {
          'mcp.token': 'Authorization',
        },
      },
    ],
  };

  it('accepts a URL matching a pattern', () => {
    expect(() =>
      checkMcpServers(
        agentDoc([
          http('https://mcp.example.com/v1/mcp'),
        ]),
        grant,
        SECRETS,
      ),
    ).not.toThrow();
  });

  it('refuses a URL matching no pattern, and every URL without an allowlist', () => {
    expectNotAllowed(
      agentDoc([
        http('https://evil.example/mcp'),
      ]),
      grant,
    );
    expectNotAllowed(
      agentDoc([
        http('http://mcp.example.com/v1/mcp'),
      ]),
      grant,
    );
    expectNotAllowed(
      agentDoc([
        http('https://mcp.example.com/v1/mcp'),
      ]),
      undefined,
    );
  });

  it('refuses one name for two servers before anything runs, across nodes and the document', () => {
    const node = (id: string, url: string) => ({
      kind: 'acp-agent' as const,
      id,
      agent: 'fake',
      prompt: 'go',
      tools: [
        {
          mcp: http(url),
        },
      ],
    });
    const twoNodes: WorkflowDocument = {
      version: 1,
      root: {
        kind: 'sequence',
        id: 'both',
        steps: [
          node('a', 'https://mcp.example.com/a'),
          node('b', 'https://mcp.example.com/b'),
        ],
      },
    };
    const docAndNode: WorkflowDocument = {
      version: 1,
      connections: {
        remote: {
          mcp: http('https://mcp.example.com/a'),
        },
      },
      root: node('b', 'https://mcp.example.com/b'),
    };
    for (const doc of [
      twoNodes,
      docAndNode,
    ]) {
      const error = thrown(() => checkMcpServers(doc, grant, SECRETS));
      assert(isNoeticConfigError(error));
      expect(error.code).toBe('CONNECTION_NAME_TAKEN');
      expect(error.message).toContain("Node 'b' names MCP server 'remote'");
    }
    const same: WorkflowDocument = {
      version: 1,
      root: {
        kind: 'sequence',
        id: 'both',
        steps: [
          node('a', 'https://mcp.example.com/a'),
          node('b', 'https://mcp.example.com/a'),
        ],
      },
    };
    expect(() => checkMcpServers(same, grant, SECRETS)).not.toThrow();
  });

  it('refuses a URL with a user or password, which a pattern could otherwise match', () => {
    expectNotAllowed(
      agentDoc([
        http('http://localhost:1@evil.example/'),
      ]),
      {
        urls: [
          {
            url: 'http://localhost:*',
          },
        ],
      },
    );
  });

  it('refuses a URL that is not http(s) or does not parse', () => {
    const any: McpAllowlist = {
      urls: [
        {
          url: 'https://*.example/*',
        },
      ],
    };
    expectNotAllowed(
      agentDoc([
        http('file:///etc/passwd'),
      ]),
      any,
    );
    expectNotAllowed(
      agentDoc([
        http('not a url'),
      ]),
      any,
    );
  });

  it('binds a secret to its one header: other headers and other secrets are refused', () => {
    expectNotAllowed(
      agentDoc([
        http('https://mcp.example.com/v1', [
          {
            name: 'X-Forward',
            value: {
              $secret: 'mcp.token',
            },
          },
        ]),
      ]),
      grant,
    );
    expectNotAllowed(
      agentDoc([
        http('https://mcp.example.com/v1', [
          {
            name: 'Authorization',
            value: {
              $secret: 'other.token',
            },
          },
        ]),
      ]),
      grant,
    );
    expect(() =>
      checkMcpServers(
        agentDoc([
          http('https://mcp.example.com/v1', [
            {
              name: 'Authorization',
              value: {
                $secret: 'mcp.token',
              },
            },
          ]),
        ]),
        grant,
        SECRETS,
      ),
    ).not.toThrow();
  });

  it('accepts a document with no MCP servers without an allowlist', () => {
    expect(() => checkMcpServers(agentDoc([]), undefined, SECRETS)).not.toThrow();
  });
});

describe('checkMcpServers — URL patterns', () => {
  function urls(...patterns: string[]): McpAllowlist {
    return {
      urls: patterns.map((url) => ({
        url,
      })),
    };
  }

  function accepts(url: string, allowlist: McpAllowlist): void {
    expect(() =>
      checkMcpServers(
        agentDoc([
          http(url),
        ]),
        allowlist,
        SECRETS,
      ),
    ).not.toThrow();
  }

  it('keeps a wildcard host label from crossing into the path, query, fragment or user', () => {
    const sub = urls('https://*.example.com/*');
    accepts('https://mcp.example.com/x', sub);
    accepts('https://a.b.example.com/x', sub);
    for (const url of [
      'https://evil.com/.example.com/x',
      'https://evil.com/?.example.com/x',
      'https://evil.com/#.example.com/x',
      'https://example.com/x',
      'https://evilexample.com/x',
      'https://.example.com/x',
      'https://a..example.com/x',
    ]) {
      expectNotAllowed(
        agentDoc([
          http(url),
        ]),
        sub,
      );
    }
  });

  it('matches the host exactly, so a suffix host does not match', () => {
    expectNotAllowed(
      agentDoc([
        http('https://mcp.example.com.evil.com/'),
      ]),
      urls('https://mcp.example.com/*'),
    );
  });

  it('refuses a pattern with `*` anywhere in the host but a leading label, or before fewer than two labels', () => {
    for (const pattern of [
      'https://mcp.example.com*',
      'https://*',
      'https://mcp.*.com/*',
      '*',
      'https://*.com/*',
      'https://*.localhost/*',
      'https://*.[::1]/*',
    ]) {
      try {
        checkMcpServers(
          agentDoc([
            http('https://mcp.example.com/'),
          ]),
          urls(pattern),
          SECRETS,
        );
        expect.unreachable(`expected CONNECTION_INVALID for ${pattern}`);
      } catch (e) {
        assert(isNoeticConfigError(e));
        expect(e.code).toBe('CONNECTION_INVALID');
      }
    }
  });

  it('applies the path glob to the path only', () => {
    const v1 = urls('https://mcp.example.com/v1/*');
    accepts('https://mcp.example.com/v1/tools?x=1', v1);
    expectNotAllowed(
      agentDoc([
        http('https://mcp.example.com/v2/tools'),
      ]),
      v1,
    );
  });

  it('reads pattern hosts and ports the way URLs are read: case and default ports', () => {
    accepts('https://mcp.example.com/x', urls('https://MCP.Example.COM/*'));
    accepts('https://mcp.example.com/x', urls('https://mcp.example.com:443/*'));
    accepts('http://localhost:8080/', urls('http://localhost:*/'));
    expectNotAllowed(
      agentDoc([
        http('https://mcp.example.com:8443/x'),
      ]),
      urls('https://mcp.example.com/*'),
    );
  });

  it('refuses a URL written differently from how it reads, since the agent gets it as written', () => {
    const grant = urls('https://mcp.example.com/*');
    for (const url of [
      'https://mcp.example.com\\@evil.com/',
      'https://mcp.example.com\t/x',
      'HTTPS://MCP.EXAMPLE.COM/x',
      'https://mcp%2Eexample.com/x',
      'https://mcp.example.com:443/x',
      'https://mcp.example.com',
      'https://mcp.example.com/a/../x',
    ]) {
      expectNotAllowed(
        agentDoc([
          http(url),
        ]),
        grant,
      );
    }
  });
});

describe('checkMcpServers — headers and grants', () => {
  const token = (name: string): WorkflowMcpSecretValue => ({
    name,
    value: {
      $secret: 'mcp.token',
    },
  });

  it('matches header names case-insensitively, and environment names exactly', () => {
    const grant: McpAllowlist = {
      urls: [
        {
          url: 'https://mcp.example.com/*',
          secrets: {
            'mcp.token': 'Authorization',
          },
        },
      ],
      commands: [
        {
          ...DOCS_GRANT.commands?.[0],
          command: 'npx',
          secrets: {
            'docs.key': 'API_KEY',
          },
        },
      ],
    };
    expect(() =>
      checkMcpServers(
        agentDoc([
          http('https://mcp.example.com/', [
            token('authorization'),
          ]),
        ]),
        grant,
        SECRETS,
      ),
    ).not.toThrow();
    expectNotAllowed(
      agentDoc([
        {
          ...DOCS_SERVER,
          env: [
            {
              name: 'api_key',
              value: {
                $secret: 'docs.key',
              },
            },
          ],
        },
      ]),
      grant,
    );
  });

  it('refuses a header or environment variable named twice', () => {
    const grant: McpAllowlist = {
      urls: [
        {
          url: 'https://mcp.example.com/*',
          secrets: {
            'mcp.token': 'Authorization',
          },
        },
      ],
      commands: [
        {
          ...DOCS_GRANT.commands?.[0],
          command: 'npx',
          secrets: {
            'docs.key': 'API_KEY',
          },
        },
      ],
    };
    const key = {
      name: 'API_KEY',
      value: {
        $secret: 'docs.key',
      },
    };
    for (const server of [
      http('https://mcp.example.com/', [
        token('authorization'),
        token('AUTHORIZATION'),
      ]),
      {
        ...DOCS_SERVER,
        env: [
          key,
          key,
        ],
      },
    ]) {
      expectNotAllowed(
        agentDoc([
          server,
        ]),
        grant,
      );
    }
  });

  it('accepts when any matching grant allows the values, whatever the grant order', () => {
    const loose = {
      url: 'https://*.example.com/*',
    };
    const tight = {
      url: 'https://mcp.example.com/*',
      secrets: {
        'mcp.token': 'Authorization',
      },
    };
    const server = http('https://mcp.example.com/', [
      token('Authorization'),
    ]);
    for (const order of [
      [
        loose,
        tight,
      ],
      [
        tight,
        loose,
      ],
    ]) {
      expect(() =>
        checkMcpServers(
          agentDoc([
            server,
          ]),
          {
            urls: order,
          },
          SECRETS,
        ),
      ).not.toThrow();
    }
    // The secret is still bound to the tight grant's URL only.
    expectNotAllowed(
      agentDoc([
        http('https://other.example.com/', [
          token('Authorization'),
        ]),
      ]),
      {
        urls: [
          tight,
          loose,
        ],
      },
    );
  });

  it('refuses values that only two grants together would allow', () => {
    expectNotAllowed(
      agentDoc([
        http('https://mcp.example.com/', [
          token('Authorization'),
          {
            name: 'X-Team',
            value: {
              $secret: 'team',
            },
          },
        ]),
      ]),
      {
        urls: [
          {
            url: 'https://mcp.example.com/*',
            secrets: {
              'mcp.token': 'Authorization',
            },
          },
          {
            url: 'https://mcp.example.com/*',
            secrets: {
              team: 'X-Team',
            },
          },
        ],
      },
    );
  });

  it('does not read a secret name off the grant object prototype', () => {
    expectNotAllowed(
      agentDoc([
        http('https://mcp.example.com/', [
          {
            name: 'Authorization',
            value: {
              $secret: 'constructor',
            },
          },
        ]),
      ]),
      {
        urls: [
          {
            url: 'https://mcp.example.com/*',
            secrets: {},
          },
        ],
      },
    );
  });

  it('refuses a $secret at validation when the harness has no secret resolver', () => {
    try {
      checkMcpServers(
        agentDoc([
          http('https://mcp.example.com/', [
            token('Authorization'),
          ]),
        ]),
        {
          urls: [
            {
              url: 'https://mcp.example.com/*',
              secrets: {
                'mcp.token': 'Authorization',
              },
            },
          ],
        },
        undefined,
      );
      expect.unreachable('expected CONNECTION_INVALID');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('CONNECTION_INVALID');
    }
  });
});

describe('mcpEntry', () => {
  it('is the host provider for the server, with the policy of the grant that allows it', async () => {
    const host = recordingHost();
    const entry = mcpEntry('n', http('https://mcp.example.com/v1'), {
      allowlist: {
        ...TOKEN_GRANT,
        provider: host.provider,
      },
    });
    expect(entry.policy).toEqual({
      deny: [
        'delete_*',
      ],
    });
    expect(entry.provider.name).toBe('remote');
    const connections = await entry.provider.connect(connectOptions());
    expect(connections).toHaveLength(1);
    expect(host.built).toEqual([
      {
        name: 'remote',
        type: 'http',
        url: 'https://mcp.example.com/v1',
        headers: [],
      },
    ]);
  });

  it('gives the same server under the same allowlist the same provider', () => {
    const allowlist: McpAllowlist = {
      ...TOKEN_GRANT,
      provider: recordingHost().provider,
    };
    const a = mcpEntry('a', http('https://mcp.example.com/v1'), {
      allowlist: allowlist,
    });
    const b = mcpEntry('b', http('https://mcp.example.com/v1'), {
      allowlist: allowlist,
    });
    const other = mcpEntry('c', http('https://mcp.example.com/v2'), {
      allowlist: allowlist,
    });
    expect(b.provider).toBe(a.provider);
    expect(other.provider).not.toBe(a.provider);
  });

  it('resolves bound secrets through the harness when it connects, and registers them for scrubbing', async () => {
    const host = recordingHost();
    const redacted: string[] = [];
    const entry = mcpEntry(
      'n',
      {
        type: 'sse',
        name: 'remote',
        url: 'https://mcp.example.com/sse',
        headers: [
          SECRET_HEADER,
        ],
      },
      {
        allowlist: {
          ...TOKEN_GRANT,
          provider: host.provider,
        },
      },
    );
    await entry.provider.connect(
      connectOptions({
        secrets: {
          async resolve(name) {
            return `Bearer ${name}-value`;
          },
        },
        redact: (value) => {
          redacted.push(value);
        },
      }),
    );
    expect(host.built).toEqual([
      {
        name: 'remote',
        type: 'sse',
        url: 'https://mcp.example.com/sse',
        headers: [
          {
            name: 'Authorization',
            value: 'Bearer mcp.token-value',
          },
        ],
      },
    ]);
    expect(redacted).toEqual([
      'Bearer mcp.token-value',
    ]);
  });

  it('a $secret without a harness secret resolver is CONNECTION_INVALID when it connects', async () => {
    const entry = mcpEntry(
      'n',
      http('https://mcp.example.com/v1', [
        SECRET_HEADER,
      ]),
      {
        allowlist: {
          ...TOKEN_GRANT,
          provider: recordingHost().provider,
        },
      },
    );
    await expectConfig(entry.provider.connect(connectOptions()), 'CONNECTION_INVALID');
  });

  it('builds a stdio server from its exact command, with only bound environment secrets', async () => {
    const host = recordingHost();
    const entry = mcpEntry('n', DOCS_SERVER, {
      allowlist: {
        ...DOCS_GRANT,
        provider: host.provider,
      },
    });
    expect(entry.policy).toBeUndefined();
    await entry.provider.connect(connectOptions());
    expect(host.built).toEqual([
      {
        name: 'docs',
        command: 'npx',
        args: [
          '-y',
          '@acme/docs-mcp',
        ],
        env: [],
      },
    ]);
  });

  it('is CONNECTION_INVALID when the allowlist has no provider, and CONNECTION_NOT_ALLOWED when nothing grants the server', () => {
    const missing = thrown(() =>
      mcpEntry('n', http('https://mcp.example.com/v1'), {
        allowlist: TOKEN_GRANT,
      }),
    );
    assert(isNoeticConfigError(missing));
    expect(missing.code).toBe('CONNECTION_INVALID');
    expect(missing.hint).toContain('mcp.provider');
    const refused = thrown(() =>
      mcpEntry('n', STDIO_TOUCH, {
        allowlist: {
          ...DOCS_GRANT,
          provider: recordingHost().provider,
        },
      }),
    );
    assert(isNoeticConfigError(refused));
    expect(refused.code).toBe('CONNECTION_NOT_ALLOWED');
  });
});

describe('parseAndRunWorkflow — MCP servers', () => {
  it('refuses an arbitrary stdio server before the agent is started', async () => {
    const record = recordingAgent();
    const harness = harnessWithSecrets();
    const message = await expectConfig(
      parseAndRunWorkflow({
        json: agentDoc([
          STDIO_TOUCH,
        ]),
        harness,
        ctx: harness.createContext(),
        tools: [],
        acpAgents: new Map([
          [
            'fake',
            record.agent,
          ],
        ]),
        mcp: DOCS_GRANT,
      }),
      'CONNECTION_NOT_ALLOWED',
    );
    expect(message).toContain('touch');
    expect(record.connects).toBe(0);
  });

  it('refuses every server when no mcp allowlist is given', async () => {
    await expectConfig(
      runDoc(
        agentDoc([
          http('https://mcp.example.com/v1'),
        ]),
      ),
      'CONNECTION_NOT_ALLOWED',
    );
  });

  it('serves a stdio tools entry as bridged tools: the exact command connects through the host, and the agent is never handed it', async () => {
    const host = recordingHost();
    const run = await runDoc(
      agentDoc([
        DOCS_SERVER,
      ]),
      {
        mcp: {
          ...DOCS_GRANT,
          provider: host.provider,
        },
      },
    );
    expect(run.output).toBe('agent done');
    expect(run.record.sessions).toEqual([
      undefined,
    ]);
    expect(run.record.served).toEqual([
      [
        'docs_lookup',
      ],
    ]);
    expect(host.built).toEqual([
      {
        name: 'docs',
        command: 'npx',
        args: [
          '-y',
          '@acme/docs-mcp',
        ],
        env: [],
      },
    ]);
  });

  it('fills a bound header secret from environment.secrets when the server connects', async () => {
    const host = recordingHost();
    const run = await runDoc(
      agentDoc([
        http('https://mcp.example.com/v1', [
          SECRET_HEADER,
        ]),
      ]),
      {
        mcp: {
          ...TOKEN_GRANT,
          provider: host.provider,
        },
        secrets: {
          'mcp.token': 'Bearer t0ken',
        },
      },
    );
    expect(run.record.served).toEqual([
      [
        'remote_lookup',
      ],
    ]);
    expect(host.built).toEqual([
      {
        name: 'remote',
        type: 'http',
        url: 'https://mcp.example.com/v1',
        headers: [
          {
            name: 'Authorization',
            value: 'Bearer t0ken',
          },
        ],
      },
    ]);
  });
});

describe('parseAndRunWorkflow — MCP server secrets', () => {
  it('refuses a $secret before the agent starts when the harness has no secret resolver', async () => {
    const record = recordingAgent();
    const harness = harnessWithSecrets();
    await expectConfig(
      parseAndRunWorkflow({
        json: agentDoc([
          http('https://mcp.example.com/', [
            {
              name: 'Authorization',
              value: {
                $secret: 'mcp.token',
              },
            },
          ]),
        ]),
        harness,
        ctx: harness.createContext(),
        tools: [],
        acpAgents: new Map([
          [
            'fake',
            record.agent,
          ],
        ]),
        mcp: {
          urls: [
            {
              url: 'https://mcp.example.com/*',
              secrets: {
                'mcp.token': 'Authorization',
              },
            },
          ],
        },
      }),
      'CONNECTION_INVALID',
    );
    expect(record.connects).toBe(0);
  });
});

describe("a document's own connections", () => {
  function connectionsDoc(
    connections: WorkflowDocument['connections'],
    pick = 'remote',
  ): WorkflowDocument {
    return {
      version: 1,
      ...(connections
        ? {
            connections,
          }
        : {}),
      root: {
        kind: 'acp-agent',
        id: 'agent',
        agent: 'fake',
        prompt: 'do the task',
        tools: [
          {
            connection: pick,
          },
        ],
      },
    };
  }

  it('attaches an { "mcp" } entry for the run, which a node picks by name', async () => {
    const host = recordingHost();
    const run = await runDoc(
      connectionsDoc({
        remote: {
          mcp: http('https://mcp.example.com/v1', [
            SECRET_HEADER,
          ]),
        },
      }),
      {
        mcp: {
          ...TOKEN_GRANT,
          provider: host.provider,
        },
        secrets: {
          'mcp.token': 'Bearer t0ken',
        },
      },
    );
    expect(run.record.served).toEqual([
      [
        'remote_lookup',
      ],
    ]);
    expect(host.built).toEqual([
      {
        name: 'remote',
        type: 'http',
        url: 'https://mcp.example.com/v1',
        headers: [
          {
            name: 'Authorization',
            value: 'Bearer t0ken',
          },
        ],
      },
    ]);
  });

  it('refuses an entry the allowlist does not grant with CONNECTION_NOT_ALLOWED', async () => {
    const message = await expectConfig(
      runDoc(
        connectionsDoc({
          remote: {
            mcp: http('https://evil.example.com/v1'),
          },
        }),
        {
          mcp: {
            ...TOKEN_GRANT,
            provider: recordingHost().provider,
          },
        },
      ),
      'CONNECTION_NOT_ALLOWED',
    );
    expect(message).toContain("The document's connections");
  });

  it('refuses a key that disagrees with the server name, a literal header and pool fields with CONNECTION_INVALID', async () => {
    const allowlist: McpAllowlist = {
      ...TOKEN_GRANT,
      provider: recordingHost().provider,
    };
    for (const json of [
      {
        version: 1,
        connections: {
          remote: {
            mcp: {
              ...http('https://mcp.example.com/v1'),
              name: 'other',
            },
          },
        },
        root: connectionsDoc(undefined).root,
      },
      {
        version: 1,
        connections: {
          remote: {
            mcp: {
              ...http('https://mcp.example.com/v1'),
              headers: [
                {
                  name: 'Authorization',
                  value: 'Bearer leaked',
                },
              ],
            },
          },
        },
        root: connectionsDoc(undefined).root,
      },
      {
        version: 1,
        connections: {
          remote: {
            mcp: http('https://mcp.example.com/v1'),
            fresh: 'run',
          },
        },
        root: connectionsDoc(undefined).root,
      },
    ]) {
      await expectConfig(
        runDoc(frameworkCast<WorkflowDocument>(json), {
          mcp: allowlist,
        }),
        // A malformed `connections` map is `CONNECTION_INVALID` (spec 35 § Errors).
        'CONNECTION_INVALID',
      );
    }
  });

  it('refuses a pick naming a connection nothing grants, before the agent starts', async () => {
    const message = await expectConfig(
      runDoc(connectionsDoc(undefined, 'nowhere')),
      'CONNECTION_NOT_ALLOWED',
    );
    expect(message).toContain("'nowhere'");
  });
});

describe('a stdio tools entry on an acp-agent node', () => {
  it("starts through the agent's spawn, where the agent runs", async () => {
    const host = recordingHost();
    const record = recordingAgent();
    const spawn: Spawn = async () => {
      throw new Error('not started in this test');
    };
    const harness = harnessWithSecrets();
    await parseAndRunWorkflow({
      json: agentDoc([
        DOCS_SERVER,
      ]),
      harness,
      ctx: harness.createContext(),
      tools: [],
      acpAgents: new Map([
        [
          'fake',
          {
            ...record.agent,
            spawn,
          },
        ],
      ]),
      mcp: {
        ...DOCS_GRANT,
        provider: host.provider,
      },
    });
    expect(host.built).toEqual([
      {
        ...DOCS_SERVER,
        spawn,
      },
    ]);
  });
});

describe('dynamicWorkflow — MCP servers', () => {
  function plannerHarness(document: WorkflowDocument, requests: CallModelRequest[]): AgentHarness {
    return new AgentHarness({
      name: 'planner',
      params: {},
      _testCallModel: async (request) => {
        requests.push(request);
        return makeLLMResponse(JSON.stringify(document));
      },
    });
  }

  it('refuses a generated stdio server the allowlist does not name, and never starts the agent', async () => {
    const record = recordingAgent();
    const requests: CallModelRequest[] = [];
    const harness = plannerHarness(
      agentDoc([
        STDIO_TOUCH,
      ]),
      requests,
    );
    await expectConfig(
      harness.run(
        dynamicWorkflow({
          tools: [],
          maxRevisions: 2,
          acpAgents: new Map([
            [
              'fake',
              record.agent,
            ],
          ]),
        }),
        'do it',
        harness.createContext(),
      ),
      'CONNECTION_NOT_ALLOWED',
    );
    expect(record.connects).toBe(0);
    // The refusal is fed back to the planner before the last revision fails.
    expect(JSON.stringify(requests[1])).toContain('CONNECTION_NOT_ALLOWED');
    expect(JSON.stringify(requests[0])).toContain('No MCP servers are available');
    await harness.close();
  });

  it('shows the planner only the allowed servers, and gives a generated callModel node the server it attaches', async () => {
    const host = recordingHost();
    const requests: CallModelRequest[] = [];
    const harness = plannerHarness(
      {
        version: 1,
        root: {
          kind: 'callModel',
          id: 'reader',
          instructions: 'look it up',
          tools: [
            {
              mcp: {
                name: 'remote',
                type: 'http',
                url: 'https://mcp.example.com/v1',
              },
            },
          ],
        },
      },
      requests,
    );
    const ctx = harness.createContext();
    await harness.run(
      dynamicWorkflow({
        tools: [],
        maxRevisions: 1,
        mcp: {
          ...TOKEN_GRANT,
          ...DOCS_GRANT,
          provider: host.provider,
        },
      }),
      'do it',
      ctx,
    );
    const prompt = JSON.stringify(requests[0]);
    expect(prompt).toContain('https://mcp.example.com/*');
    expect(prompt).toContain('@acme/docs-mcp');
    expect(prompt).not.toContain('evil');
    const reader = requests[1];
    assert(reader && 'tools' in reader);
    expect((reader.tools ?? []).map((tool) => tool.name)).toContain('remote_lookup');
    expect(reader.allowedToolNames).toEqual([
      'remote_lookup',
    ]);
    expect(host.built).toHaveLength(1);
    expect(ctx.itemLog.items.length).toBeGreaterThan(0);
    await harness.close();
  });
});

describe('mcpPrompt', () => {
  it('lists each URL pattern with its secret headers, and each exact command', () => {
    const prompt = mcpPrompt({
      urls: [
        {
          url: 'https://mcp.example.com/*',
          secrets: {
            'mcp.token': 'Authorization',
          },
        },
      ],
      ...DOCS_GRANT,
    });
    expect(prompt).toContain('https://mcp.example.com/*');
    expect(prompt).toContain('{ "name": "Authorization", "value": { "$secret": "mcp.token" } }');
    expect(prompt).toContain('"command": "npx", "args": ["-y","@acme/docs-mcp"]');
  });

  it('tells the planner to attach no servers when none are allowed', () => {
    expect(mcpPrompt(undefined)).toContain('do not give a node an { "mcp": … } tool entry');
    expect(mcpPrompt({})).toContain('do not give a node an { "mcp": … } tool entry');
  });
});
