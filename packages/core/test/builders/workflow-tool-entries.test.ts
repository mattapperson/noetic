// A document's connection tool entries (spec 26 § Tools): `{ connection, ops? }`
// picks of harness and turn connections, inline `{ mcp }` servers built from the
// host's allowlist, and how both reach a model when a step runs the document in
// the middle of a turn.

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpAgent,
  ConnectionAllowlist,
  ConnectionProvider,
  GrantedMcpServer,
  McpAllowlist,
  WorkflowDocument,
  WorkflowNode,
  WorkflowToolEntry,
} from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError, WorkflowDocumentSchema } from '@noetic-tools/types';
import { z } from 'zod';
import { dynamicWorkflow, parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { runCode } from '../../src/builders/step-builders';
import { checkToolConnections, stepTools } from '../../src/builders/workflow-tool-entries';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { FakeOpenRouter } from '../_helpers';
import { makeLLMResponse, startFakeOpenRouter } from '../_helpers';

//#region Fixtures

const servers: FakeOpenRouter[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

function device(name: string): ConnectionProvider {
  return createInMemoryConnection({
    name,
    operations: {
      ping: {
        inputSchema: {
          type: 'object',
        },
        run: () => `pong from ${name}`,
      },
      reboot: {
        effects: true,
        inputSchema: {
          type: 'object',
        },
        run: () => 'rebooted',
      },
    },
  });
}

/** A host provider backing every granted server in memory, recording what it built. */
function host(): {
  readonly provider: (server: GrantedMcpServer) => ConnectionProvider;
  readonly built: GrantedMcpServer[];
} {
  const built: GrantedMcpServer[] = [];
  return {
    built,
    provider: (server) => {
      built.push(server);
      return device(server.name);
    },
  };
}

const URL_GRANT = 'https://mcp.example.com/*';

function grant(provider: (server: GrantedMcpServer) => ConnectionProvider): McpAllowlist {
  return {
    urls: [
      {
        url: URL_GRANT,
        secrets: {
          'remote.token': 'Authorization',
        },
        policy: {
          deny: [
            'reboot',
          ],
        },
      },
    ],
    provider,
  };
}

function modelDoc(tools: unknown[] | undefined): unknown {
  return {
    version: 1,
    root: {
      kind: 'callModel',
      id: 'reader',
      instructions: 'look',
      model: 'test/model',
      tools,
    },
  };
}

/** A model that calls `tool` once, then answers with every tool output it saw. */
function callsOnce(tool: string): (input: unknown[]) => unknown[] {
  return (input) => {
    const outputs = input.flatMap((entry) => {
      const parsed = z
        .object({
          type: z.literal('function_call_output'),
          output: z.unknown(),
        })
        .safeParse(entry);
      return parsed.success
        ? [
            String(parsed.data.output),
          ]
        : [];
    });
    if (outputs.length === 0) {
      return [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: tool,
          arguments: '{}',
          status: 'completed',
        },
      ];
    }
    return [
      {
        type: 'message',
        id: `msg_${crypto.randomUUID()}`,
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: `saw ${outputs.join(' | ')}`,
            annotations: [],
          },
        ],
      },
    ];
  };
}

interface DocRun {
  readonly output: string | undefined;
  readonly error: unknown;
  readonly model: FakeOpenRouter;
}

/**
 * Runs `json` through parseAndRunWorkflow from a step of a turn whose harness
 * holds a `phone` connection, so the turn's tool set is built before the
 * document exists.
 */
async function runInTurn(
  json: unknown,
  opts: {
    readonly reply?: (input: unknown[]) => unknown[];
    readonly mcp?: McpAllowlist;
    readonly connections?: ConnectionAllowlist;
    readonly acpAgents?: ReadonlyMap<string, AcpAgent>;
  } = {},
): Promise<DocRun> {
  const model = startFakeOpenRouter(opts.reply ?? callsOnce('phone_ping'));
  servers.push(model);
  let output: string | undefined;
  let error: unknown;
  const harness: AgentHarness = new AgentHarness({
    name: 'json-tools',
    params: {},
    connections: [
      device('phone'),
    ],
    environment: {
      secrets: {
        async resolve(name) {
          return `Bearer ${name}`;
        },
      },
    },
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: model.baseUrl,
    },
    agentGraph: runCode({
      id: 'run-doc',
      execute: async (_input: string, ctx) => {
        try {
          output = await parseAndRunWorkflow({
            json,
            harness,
            ctx,
            tools: [],
            ...(opts.mcp
              ? {
                  mcp: opts.mcp,
                }
              : {}),
            ...(opts.connections
              ? {
                  connections: opts.connections,
                }
              : {}),
            ...(opts.acpAgents
              ? {
                  acpAgents: opts.acpAgents,
                }
              : {}),
          });
        } catch (e) {
          error = e;
        }
        return 'ran';
      },
    }),
  });
  try {
    await harness.execute('go', {
      threadId: 't',
    });
    await harness.getAgentResponse({
      threadId: 't',
    });
  } finally {
    await harness.close();
  }
  return {
    output,
    error,
    model,
  };
}

function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

function codeOf(error: unknown): string | undefined {
  const cause = rootCause(error);
  return isNoeticConfigError(cause) ? cause.code : undefined;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function parses(root: unknown): boolean {
  return WorkflowDocumentSchema.safeParse({
    version: 1,
    root,
  }).success;
}

function asDoc(json: unknown): WorkflowDocument {
  return WorkflowDocumentSchema.parse(json);
}

function acpNode(tools: unknown[]): unknown {
  return {
    kind: 'acp-agent',
    id: 'agent',
    agent: 'fake',
    prompt: 'go',
    tools,
  };
}

//#endregion

describe('tool entries in the schema', () => {
  it('accepts connection picks and inline HTTP and stdio MCP servers on callModel and acp-agent nodes', () => {
    const entries = [
      {
        connection: 'phone',
      },
      {
        connection: 'phone',
        ops: [
          'ping',
        ],
      },
      {
        mcp: {
          name: 'remote',
          type: 'http',
          url: 'https://mcp.example.com/v1',
        },
      },
      {
        mcp: {
          name: 'remote',
          type: 'http',
          url: 'https://mcp.example.com/v1',
          headers: [
            {
              name: 'Authorization',
              value: {
                $secret: 'remote.token',
              },
            },
          ],
        },
      },
      {
        mcp: {
          name: 'docs',
          command: 'docs-mcp',
          args: [
            '--stdio',
          ],
          env: [
            {
              name: 'DOCS_TOKEN',
              value: {
                $secret: 'docs.token',
              },
            },
          ],
        },
      },
    ] satisfies WorkflowToolEntry[];
    const model = asDoc(modelDoc(entries)).root;
    assert(model.kind === 'callModel');
    expect(model.tools).toEqual(entries);
    expect(parses(acpNode(entries))).toBe(true);
  });

  it('refuses a URL with a command, a missing type, a policy, a literal header or a bad name in a document entry', () => {
    const refused: unknown[] = [
      {
        mcp: {
          name: 'evil',
          type: 'http',
          url: 'https://mcp.example.com/v1',
          command: 'touch',
        },
      },
      {
        mcp: {
          name: 'remote',
          url: 'https://mcp.example.com/v1',
        },
      },
      {
        mcp: {
          name: 'remote',
          type: 'http',
          url: 'https://mcp.example.com/v1',
          policy: {
            allow: [
              '*',
            ],
          },
        },
      },
      {
        connection: 'phone',
        policy: {
          allow: [
            '*',
          ],
        },
      },
      {
        mcp: {
          name: 'remote',
          type: 'http',
          url: 'https://mcp.example.com/v1',
          headers: [
            {
              name: 'Authorization',
              value: 'Bearer leaked',
            },
          ],
        },
      },
      {
        connection: '1phone',
      },
    ];
    for (const entry of refused) {
      expect(
        WorkflowDocumentSchema.safeParse(
          modelDoc([
            entry,
          ]),
        ).success,
      ).toBe(false);
    }
  });

  it('takes a registered tool entry on an acp-agent node, as on callModel', () => {
    expect(
      parses(
        acpNode([
          {
            type: 'search',
          },
        ]),
      ),
    ).toBe(true);
  });
});

describe('checkToolConnections', () => {
  const allowlist: ConnectionAllowlist = {
    phone: {
      ops: [
        'ping',
        'get_*',
      ],
    },
  };

  function check(entry: unknown): unknown {
    return thrown(() =>
      checkToolConnections(
        asDoc(
          modelDoc([
            entry,
          ]),
        ),
        allowlist,
      ),
    );
  }

  it('accepts an allowed connection, with ops inside the granted globs', () => {
    expect(
      check({
        connection: 'phone',
      }),
    ).toBeUndefined();
    expect(
      check({
        connection: 'phone',
        ops: [
          'ping',
          'get_issue',
          'get_*',
        ],
      }),
    ).toBeUndefined();
  });

  it('refuses a connection the allowlist does not name, and ops globs wider than it grants', () => {
    for (const entry of [
      {
        connection: 'laptop',
      },
      {
        connection: 'phone',
        ops: [
          '*',
        ],
      },
      {
        connection: 'phone',
        ops: [
          'reboot',
        ],
      },
      {
        connection: 'phone',
        ops: [
          'g*',
        ],
      },
    ]) {
      const error = check(entry);
      assert(isNoeticConfigError(error), JSON.stringify(entry));
      expect(error.code).toBe('CONNECTION_NOT_ALLOWED');
    }
  });

  it('checks inline subflows and acp-agent nodes', () => {
    const error = thrown(() =>
      checkToolConnections(
        asDoc({
          version: 1,
          root: {
            kind: 'subflow',
            id: 'outer',
            document: {
              version: 1,
              root: acpNode([
                {
                  connection: 'laptop',
                },
              ]),
            },
          },
        }),
        allowlist,
      ),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('CONNECTION_NOT_ALLOWED');
  });
});

describe('stepTools', () => {
  const tools = new Map();

  function modelNode(json: unknown): Extract<
    WorkflowNode,
    {
      kind: 'callModel';
    }
  > {
    const root = asDoc(json).root;
    assert(root.kind === 'callModel');
    return root;
  }

  it('narrows a pick to the granted operations under an allowlist, and keeps it as written without one', () => {
    const node = modelNode(
      modelDoc([
        {
          connection: 'phone',
        },
        {
          connection: 'phone',
          ops: [
            'ping',
          ],
        },
      ]),
    );
    expect(
      stepTools(node.id, node.tools ?? [], {
        tools,
        allowlist: {
          phone: {
            ops: [
              'p*',
            ],
          },
        },
      }),
    ).toEqual([
      {
        kind: 'connection-pick',
        connection: 'phone',
        ops: [
          'p*',
        ],
      },
      {
        kind: 'connection-pick',
        connection: 'phone',
        ops: [
          'ping',
        ],
      },
    ]);
    expect(
      stepTools(node.id, node.tools ?? [], {
        tools,
      }),
    ).toEqual([
      {
        kind: 'connection-pick',
        connection: 'phone',
      },
      {
        kind: 'connection-pick',
        connection: 'phone',
        ops: [
          'ping',
        ],
      },
    ]);
  });

  it('gives a pick no operations when the allowlist grants the connection none', () => {
    const node = modelNode(
      modelDoc([
        {
          connection: 'phone',
        },
      ]),
    );
    expect(
      stepTools(node.id, node.tools ?? [], {
        tools,
        allowlist: {
          phone: {
            events: [
              'ring',
            ],
          },
        },
      }),
    ).toEqual([
      {
        kind: 'connection-pick',
        connection: 'phone',
        ops: [],
      },
    ]);
  });

  it('refuses an inline server with no mcp allowlist', () => {
    const node = modelNode(
      modelDoc([
        {
          mcp: {
            name: 'remote',
            type: 'http',
            url: 'https://mcp.example.com/v1',
          },
        },
      ]),
    );
    const error = thrown(() =>
      stepTools(node.id, node.tools ?? [], {
        tools,
      }),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('CONNECTION_NOT_ALLOWED');
  });
});

describe('a document run in the middle of a turn', () => {
  it('a { connection, ops } pick offers only the matching tools of a harness connection', async () => {
    const run = await runInTurn(
      modelDoc([
        {
          connection: 'phone',
          ops: [
            'ping',
          ],
        },
      ]),
    );
    expect(run.error).toBeUndefined();
    expect(run.output).toBe('saw pong from phone');
    expect(run.model.rounds[0]?.toolChoice).toEqual({
      type: 'allowed_tools',
      mode: 'auto',
      tools: [
        {
          type: 'function',
          name: 'phone_ping',
        },
      ],
    });
  });

  it('an inline server connects through the host provider with its grant’s secret and policy, and is released with the turn', async () => {
    const built = host();
    const run = await runInTurn(
      modelDoc([
        {
          mcp: {
            name: 'remote',
            type: 'http',
            url: 'https://mcp.example.com/v1',
            headers: [
              {
                name: 'Authorization',
                value: {
                  $secret: 'remote.token',
                },
              },
            ],
          },
        },
      ]),
      {
        reply: callsOnce('remote_reboot'),
        mcp: grant(built.provider),
      },
    );
    expect(run.error).toBeUndefined();
    expect(built.built).toEqual([
      {
        name: 'remote',
        type: 'http',
        url: 'https://mcp.example.com/v1',
        headers: [
          {
            name: 'Authorization',
            value: 'Bearer remote.token',
          },
        ],
      },
    ]);
    // The grant denies reboot: the document cannot widen that.
    expect(run.output).not.toContain('rebooted');
    expect(run.model.rounds[0]?.tools).toContain('remote_ping');
    expect(JSON.stringify(run.model.rounds)).not.toContain('Bearer remote.token');
  });

  it('an inline server under a name the harness holds is CONNECTION_NAME_TAKEN', async () => {
    const run = await runInTurn(
      modelDoc([
        {
          mcp: {
            name: 'phone',
            type: 'http',
            url: 'https://mcp.example.com/v1',
          },
        },
      ]),
      {
        mcp: grant(host().provider),
      },
    );
    expect(codeOf(run.error)).toBe('CONNECTION_NAME_TAKEN');
    expect(run.model.rounds).toHaveLength(0);
  });

  it('an inline server the allowlist does not grant is refused before anything runs', async () => {
    const built = host();
    const run = await runInTurn(
      modelDoc([
        {
          mcp: {
            name: 'evil',
            type: 'http',
            url: 'https://evil.example/mcp',
          },
        },
      ]),
      {
        mcp: grant(built.provider),
      },
    );
    expect(codeOf(run.error)).toBe('CONNECTION_NOT_ALLOWED');
    expect(built.built).toHaveLength(0);
    expect(run.model.rounds).toHaveLength(0);
  });

  it('a policy written in the document fails validation, and an ungranted command is not allowed; neither connects', async () => {
    const built = host();
    for (const entry of [
      {
        mcp: {
          name: 'remote',
          type: 'http',
          url: 'https://mcp.example.com/v1',
          policy: {
            allow: [
              '*',
            ],
          },
        },
      },
    ]) {
      const run = await runInTurn(
        modelDoc([
          entry,
        ]),
        {
          mcp: grant(built.provider),
        },
      );
      expect(codeOf(run.error)).toBe('WORKFLOW_VALIDATION_FAILED');
    }
    const command = await runInTurn(
      modelDoc([
        {
          mcp: {
            name: 'remote',
            command: 'touch',
            args: [
              '/tmp/pwned',
            ],
          },
        },
      ]),
      {
        mcp: grant(built.provider),
      },
    );
    expect(codeOf(command.error)).toBe('CONNECTION_NOT_ALLOWED');
    expect(built.built).toHaveLength(0);
  });

  it('a pick under a connections allowlist reaches only the granted operations', async () => {
    const run = await runInTurn(
      modelDoc([
        {
          connection: 'phone',
        },
      ]),
      {
        reply: callsOnce('phone_reboot'),
        connections: {
          phone: {
            ops: [
              'ping',
            ],
          },
        },
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.output).not.toContain('rebooted');
    expect(JSON.stringify(run.model.rounds[0]?.toolChoice)).not.toContain('phone_reboot');
  });

  it('a callModel node with no tools under an empty connections allowlist cannot run an effect op', async () => {
    const run = await runInTurn(modelDoc(undefined), {
      reply: callsOnce('phone_reboot'),
      connections: {},
    });
    expect(run.error).toBeUndefined();
    expect(run.output).not.toContain('rebooted');
    expect(JSON.stringify(run.model.rounds[0]?.tools)).not.toContain('phone_');
  });

  it('a callModel node with no tools gets exactly the granted operations', async () => {
    const run = await runInTurn(modelDoc(undefined), {
      reply: callsOnce('phone_reboot'),
      connections: {
        phone: {
          ops: [
            'ping',
          ],
        },
      },
    });
    expect(run.error).toBeUndefined();
    expect(run.output).not.toContain('rebooted');
    const allowed = JSON.stringify(run.model.rounds[0]?.toolChoice);
    expect(allowed).toContain('phone_ping');
    expect(allowed).not.toContain('phone_reboot');
  });

  it('an acp-agent node with no tools under an empty connections allowlist cannot run an effect op', async () => {
    const seen: Array<{
      readonly offered: string[];
      readonly output: string;
    }> = [];
    const agent: AcpAgent = {
      specificationVersion: 'acp-v1',
      agentId: 'fake',
      connect: async (opts) => {
        const tools = opts.host.tools;
        const result = await tools?.call({
          name: 'phone_reboot',
          args: {},
          agentCallId: 'c1',
          signal: new AbortController().signal,
        });
        seen.push({
          offered: (tools?.tools ?? []).map((tool) => tool.name),
          output: result?.output ?? 'no tools',
        });
        throw new Error('stop after the call');
      },
    };
    const run = await runInTurn(
      {
        version: 1,
        root: {
          kind: 'acp-agent',
          id: 'agent',
          agent: 'fake',
          prompt: 'go',
        },
      },
      {
        connections: {},
        acpAgents: new Map([
          [
            'fake',
            agent,
          ],
        ]),
      },
    );
    expect(String(run.error)).toContain('stop after the call');
    expect(seen).toEqual([
      {
        offered: [],
        output: 'no tools',
      },
    ]);
  });

  it('a node with no tools under an allowlist still gets the servers its document attaches', async () => {
    const built = host();
    const run = await runInTurn(
      {
        version: 1,
        connections: {
          remote: {
            mcp: {
              name: 'remote',
              type: 'http',
              url: 'https://mcp.example.com/v1',
            },
          },
        },
        root: {
          kind: 'callModel',
          id: 'reader',
          instructions: 'look',
          model: 'test/model',
        },
      },
      {
        reply: callsOnce('remote_ping'),
        mcp: grant(built.provider),
        connections: {},
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.output).toContain('pong from remote');
    const allowed = JSON.stringify(run.model.rounds[0]?.toolChoice);
    expect(allowed).toContain('remote_ping');
    expect(allowed).not.toContain('phone_');
  });

  it("an acp-agent node's connection entries reach its agent through the bridge, by their harness names", async () => {
    const served: string[][] = [];
    const agent: AcpAgent = {
      specificationVersion: 'acp-v1',
      agentId: 'fake',
      connect: async (opts) => {
        served.push((opts.host.tools?.tools ?? []).map((tool) => tool.name));
        throw new Error('stop after the tool list');
      },
    };
    const run = await runInTurn(
      {
        version: 1,
        root: acpNode([
          {
            connection: 'phone',
            ops: [
              'ping',
            ],
          },
        ]),
      },
      {
        acpAgents: new Map([
          [
            'fake',
            agent,
          ],
        ]),
      },
    );
    expect(String(run.error)).toContain('stop after the tool list');
    expect(served).toEqual([
      [
        'phone_ping',
      ],
    ]);
  });
});

describe('dynamicWorkflow — connection tool entries', () => {
  it('refuses a generated pick wider than the allowlist, and feeds the refusal back', async () => {
    const plans: string[] = [];
    const harness = new AgentHarness({
      name: 'planner',
      params: {},
      connections: [
        device('phone'),
      ],
      _testCallModel: async (request) => {
        plans.push(JSON.stringify(request.instructions));
        return makeLLMResponse(
          JSON.stringify(
            modelDoc([
              {
                connection: 'phone',
                ops: [
                  '*',
                ],
              },
            ]),
          ),
        );
      },
    });
    const error = await harness
      .run(
        dynamicWorkflow({
          tools: [],
          maxRevisions: 2,
          connections: {
            phone: {
              ops: [
                'ping',
              ],
            },
          },
        }),
        'go',
        harness.createContext(),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(codeOf(error)).toBe('CONNECTION_NOT_ALLOWED');
    expect(plans[0]).toContain('{ \\"connection\\": \\"<name>\\"');
    expect(plans[1]).toContain('CONNECTION_NOT_ALLOWED');
    await harness.close();
  });
});
