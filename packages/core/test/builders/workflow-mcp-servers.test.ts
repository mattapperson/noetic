// The MCP servers a document's acp-agent nodes may hand an agent (spec 26 § MCP
// servers): the host's `mcp` allowlist, checked by parseAndRunWorkflow and
// dynamicWorkflow before anything runs, and `$secret` header and env values.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpAgent,
  AcpMcpServer,
  CallModelRequest,
  Context,
  McpAllowlist,
  SecretResolver,
  WorkflowDocument,
  WorkflowMcpServer,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { dynamicWorkflow, parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import {
  checkMcpServers,
  mcpPrompt,
  stepMcpServers,
} from '../../src/builders/workflow-mcp-servers';
import { AgentHarness } from '../../src/harness/agent-harness';
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

/** Literal values only, so it is both a document's server and the ACP server the agent gets. */
const DOCS_SERVER = {
  name: 'docs',
  command: 'npx',
  args: [
    '-y',
    '@acme/docs-mcp',
  ],
  env: [],
} satisfies WorkflowMcpServer & AcpMcpServer;

function agentDoc(servers: WorkflowMcpServer[]): WorkflowDocument {
  return {
    version: 1,
    root: {
      kind: 'acp-agent',
      id: 'agent',
      agent: 'fake',
      prompt: 'do the task',
      mcpServers: servers,
    },
  };
}

function http(url: string, headers: AcpMcpServerHeader[] = []): WorkflowMcpServer {
  return {
    type: 'http',
    name: 'remote',
    url,
    headers,
  };
}

type AcpMcpServerHeader = Extract<
  WorkflowMcpServer,
  {
    url: string;
  }
>['headers'][number];

/** An agent that records each connect and the servers each session is created with. */
function recordingAgent(): {
  agent: AcpAgent;
  connects: number;
  sessions: Array<ReadonlyArray<AcpMcpServer> | undefined>;
} {
  const record = {
    connects: 0,
    sessions: frameworkCast<Array<ReadonlyArray<AcpMcpServer> | undefined>>([]),
  };
  const agent: AcpAgent = {
    specificationVersion: 'acp-v1',
    agentId: 'fake',
    async connect() {
      record.connects += 1;
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

  it('refuses a literal environment value, and accepts only the bound secret', () => {
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
              value: '--require /tmp/evil.js',
            },
          ],
        },
      ]),
      grant,
    );
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

  it('binds a secret to its one header: literal values and other headers are refused', () => {
    expectNotAllowed(
      agentDoc([
        http('https://mcp.example.com/v1', [
          {
            name: 'Authorization',
            value: 'Bearer leaked',
          },
        ]),
      ]),
      grant,
    );
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

  it('refuses a pattern with `*` anywhere in the host but a leading label', () => {
    for (const pattern of [
      'https://mcp.example.com*',
      'https://*',
      'https://mcp.*.com/*',
      '*',
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
  const token = (name: string): AcpMcpServerHeader => ({
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

describe('stepMcpServers', () => {
  it('passes servers without secrets through as written', () => {
    const servers = [
      DOCS_SERVER,
    ];
    expect(stepMcpServers(servers)).toBe(servers);
    expect(stepMcpServers(undefined)).toBeUndefined();
  });

  it('a $secret without a harness secret resolver is CONNECTION_INVALID', async () => {
    const lazy = stepMcpServers([
      http('https://mcp.example.com/v1', [
        {
          name: 'Authorization',
          value: {
            $secret: 'mcp.token',
          },
        },
      ]),
    ]);
    assert(typeof lazy === 'function');
    const harness = harnessWithSecrets();
    await expectConfig(Promise.resolve(lazy(harness.createContext())), 'CONNECTION_INVALID');
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

  it('runs an allowlisted stdio server and hands it to the agent unchanged', async () => {
    const { output, ctx, record } = await runDoc(
      agentDoc([
        DOCS_SERVER,
      ]),
      {
        mcp: DOCS_GRANT,
      },
    );
    expect(output).toBe('agent done');
    expect(record.sessions).toEqual([
      [
        DOCS_SERVER,
      ],
    ]);
    expect(ctx.itemLog.items.length).toBeGreaterThan(0);
  });

  it('fills a bound header secret from environment.secrets when the session starts', async () => {
    const { record, ctx } = await runDoc(
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
      {
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
        secrets: {
          'mcp.token': 'Bearer t0ken',
        },
      },
    );
    expect(record.sessions).toEqual([
      [
        {
          type: 'http',
          name: 'remote',
          url: 'https://mcp.example.com/v1',
          headers: [
            {
              name: 'Authorization',
              value: 'Bearer t0ken',
            },
          ],
        },
      ],
    ]);
    expect(ctx.itemLog.items.length).toBeGreaterThan(0);
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

  it('shows the planner only the allowed servers, and runs a generated document that uses one', async () => {
    const record = recordingAgent();
    const requests: CallModelRequest[] = [];
    const harness = plannerHarness(
      agentDoc([
        DOCS_SERVER,
      ]),
      requests,
    );
    const ctx = harness.createContext();
    const output = await harness.run(
      dynamicWorkflow({
        tools: [],
        maxRevisions: 1,
        acpAgents: new Map([
          [
            'fake',
            record.agent,
          ],
        ]),
        mcp: DOCS_GRANT,
      }),
      'do it',
      ctx,
    );
    expect(output).toBe('agent done');
    expect(record.sessions).toEqual([
      [
        DOCS_SERVER,
      ],
    ]);
    const prompt = JSON.stringify(requests[0]);
    expect(prompt).toContain('@acme/docs-mcp');
    expect(prompt).not.toContain('touch');
    expect(ctx.itemLog.items.length).toBeGreaterThan(0);
    await harness.close();
  });
});

describe('mcpPrompt', () => {
  it('lists each URL pattern with its secret headers and each exact command', () => {
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

  it('tells the planner to give no servers when none are allowed', () => {
    expect(mcpPrompt(undefined)).toContain('do not give acp-agent nodes "mcpServers"');
    expect(mcpPrompt({})).toContain('do not give acp-agent nodes "mcpServers"');
  });
});
