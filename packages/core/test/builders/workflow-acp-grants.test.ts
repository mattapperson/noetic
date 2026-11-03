// What a document's acp-agent nodes may ask of an agent (spec 26 § ACP agents):
// the host's `acp` allowlist, checked by parseAndRunWorkflow and dynamicWorkflow
// before anything runs, and the session namespace each document run gets.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpAgent,
  AcpAllowlist,
  AcpClientCapabilityConfig,
  AcpPermissionPolicy,
  CallModelRequest,
  WorkflowDocument,
  WorkflowNode,
} from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { dynamicWorkflow, parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { step } from '../../src/builders/step-builders';
import {
  acpBounds,
  acpPrompt,
  boundedAcpSettings,
  checkAcpAgents,
} from '../../src/builders/workflow-acp-grants';
import { AgentHarness } from '../../src/harness/agent-harness';
import { makeLLMResponse, makeMessage } from '../_helpers';

//#region Helpers

type AcpAgentNode = Extract<
  WorkflowNode,
  {
    kind: 'acp-agent';
  }
>;

const CWD = '/work';

function agentNode(fields: Partial<AcpAgentNode> = {}): AcpAgentNode {
  return {
    kind: 'acp-agent',
    id: 'agent',
    agent: 'fake',
    prompt: 'do the task',
    ...fields,
  };
}

function docOf(...nodes: AcpAgentNode[]): WorkflowDocument {
  const [first, ...rest] = nodes;
  assert(first);
  return {
    version: 1,
    root:
      rest.length === 0
        ? first
        : {
            kind: 'sequence',
            id: 'seq',
            steps: nodes,
          },
  };
}

function expectCode(run: () => unknown, code: string): string {
  try {
    run();
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe(code);
    return e.message;
  }
  expect.unreachable(`expected ${code}`);
  return '';
}

function expectRefused(fields: Partial<AcpAgentNode>, grants?: AcpAllowlist): string {
  return expectCode(
    () => checkAcpAgents(docOf(agentNode(fields)), grants, CWD),
    'CONNECTION_NOT_ALLOWED',
  );
}

function expectAccepted(fields: Partial<AcpAgentNode>, grants?: AcpAllowlist): void {
  expect(() => checkAcpAgents(docOf(agentNode(fields)), grants, CWD)).not.toThrow();
}

interface AgentRecord {
  agent: AcpAgent;
  connects: number;
  capabilities: Array<AcpClientCapabilityConfig | undefined>;
  permissions: Array<AcpPermissionPolicy | undefined>;
  loads: string[];
  cwds: string[];
  modes: string[];
}

/** An agent that records what each connect and turn was handed. */
function recordingAgent(): AgentRecord {
  const record: AgentRecord = {
    agent: {
      specificationVersion: 'acp-v1',
      agentId: 'fake',
      async connect(opts) {
        record.connects += 1;
        record.capabilities.push(opts.host.capabilities);
        const session = {
          sessionId: 's1',
          availableCommands: [],
          async prompt() {
            record.permissions.push(opts.host.permissions);
            return {
              stopReason: 'end_turn' as const,
              items: [
                makeMessage('assistant', 'agent done'),
              ],
              text: 'agent done',
            };
          },
          async cancel() {
            // Nothing in flight.
          },
          async setMode(mode: string) {
            record.modes.push(mode);
          },
          async setModel() {
            // No models.
          },
        };
        return {
          agentCapabilities: {
            loadSession: true,
          },
          authMethods: [],
          protocolVersion: 1,
          async authenticate() {
            // No auth in the fake.
          },
          async newSession(opts) {
            record.cwds.push(opts.cwd);
            return session;
          },
          async loadSession(load) {
            record.loads.push(load.sessionId);
            return session;
          },
          async close() {
            // Nothing to release.
          },
        };
      },
    },
    connects: 0,
    capabilities: [],
    permissions: [],
    loads: [],
    cwds: [],
    modes: [],
  };
  return record;
}

function agents(record: AgentRecord): ReadonlyMap<string, AcpAgent> {
  return new Map([
    [
      'fake',
      record.agent,
    ],
  ]);
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

function harnessAt(cwd: string): AgentHarness {
  return new AgentHarness({
    name: 'acp-grants',
    params: {},
    initialCwd: cwd,
  });
}

//#endregion

describe('checkAcpAgents — permissions', () => {
  it('refuses default "allow" unless the grant allows it', () => {
    const message = expectRefused({
      permissions: {
        default: 'allow',
      },
    });
    expect(message).toContain('permissions.default');
    expectAccepted(
      {
        permissions: {
          default: 'allow',
        },
      },
      {
        fake: {
          permissions: {
            default: 'allow',
          },
        },
      },
    );
    expectAccepted({
      permissions: {
        default: 'cancel',
      },
    });
  });

  it('refuses persist unless the grant allows it', () => {
    expectRefused({
      permissions: {
        persist: true,
      },
    });
    expectAccepted(
      {
        permissions: {
          persist: true,
        },
      },
      {
        fake: {
          permissions: {
            persist: true,
          },
        },
      },
    );
  });

  it('accepts only allow rules within a granted rule, and any deny rule', () => {
    const grants: AcpAllowlist = {
      fake: {
        permissions: {
          allow: [
            {
              kind: 'read',
              title: 'docs',
            },
          ],
        },
      },
    };
    expectRefused({
      permissions: {
        allow: [
          {
            kind: 'read',
          },
        ],
      },
    });
    expectAccepted(
      {
        permissions: {
          allow: [
            {
              kind: 'read',
              title: 'Read DOCS index',
            },
          ],
        },
      },
      grants,
    );
    for (const rule of [
      {
        kind: 'execute' as const,
        title: 'docs',
      },
      {
        kind: 'read' as const,
      },
      {
        title: 'docs',
      },
      {
        kind: 'read' as const,
        title: 'doc',
      },
    ]) {
      expectRefused(
        {
          permissions: {
            allow: [
              rule,
            ],
          },
        },
        grants,
      );
    }
    expectAccepted({
      permissions: {
        deny: [
          {
            kind: 'execute',
          },
        ],
      },
    });
  });
});

describe('checkAcpAgents — mode and model', () => {
  it("refuses any mode by default, since a mode can lift the agent's prompts", () => {
    for (const mode of [
      'bypassPermissions',
      'acceptEdits',
      'default',
    ]) {
      expect(
        expectRefused({
          mode,
        }),
      ).toContain(`mode "${mode}"`);
    }
  });

  it('accepts only the granted modes', () => {
    const grants: AcpAllowlist = {
      fake: {
        modes: [
          'default',
          'plan',
        ],
      },
    };
    expectAccepted(
      {
        mode: 'plan',
      },
      grants,
    );
    expectRefused(
      {
        mode: 'bypassPermissions',
      },
      grants,
    );
  });

  it('accepts any model until the grant lists some, then only those', () => {
    expectAccepted({
      model: 'opus',
    });
    const grants: AcpAllowlist = {
      fake: {
        models: [
          'sonnet',
        ],
      },
    };
    expectAccepted(
      {
        model: 'sonnet',
      },
      grants,
    );
    expect(
      expectRefused(
        {
          model: 'opus',
        },
        grants,
      ),
    ).toContain('model "opus"');
    expectRefused(
      {
        model: 'opus',
      },
      {
        fake: {
          models: [],
        },
      },
    );
  });
});

describe('checkAcpAgents — cwd', () => {
  it('accepts the harness cwd and directories under it by default', () => {
    expectAccepted({});
    expectAccepted({
      cwd: '/work',
    });
    expectAccepted({
      cwd: '/work/sub/dir',
    });
  });

  it('refuses a cwd outside the harness cwd, or one that is not plain and absolute', () => {
    for (const cwd of [
      '/',
      '/etc',
      '/work-secrets',
      '/work/../etc',
      '/work/./sub',
      '/work//sub',
      '/work/sub/',
      'work/sub',
      '/work\\..\\etc',
    ]) {
      expectRefused({
        cwd,
      });
    }
  });

  it('holds the cwd to the granted directory instead of the harness cwd', () => {
    const grants: AcpAllowlist = {
      fake: {
        cwd: '/repo/',
      },
    };
    expectAccepted(
      {
        cwd: '/repo/pkg',
      },
      grants,
    );
    expectRefused(
      {
        cwd: '/work',
      },
      grants,
    );
  });
});

describe('checkAcpAgents — client capabilities', () => {
  it('refuses terminal and writeTextFile by default, and accepts readTextFile', () => {
    expect(
      expectRefused({
        clientCapabilities: {
          terminal: true,
        },
      }),
    ).toContain('clientCapabilities.terminal');
    expectRefused({
      clientCapabilities: {
        writeTextFile: true,
      },
    });
    expectAccepted({
      clientCapabilities: {
        readTextFile: true,
        writeTextFile: false,
        terminal: false,
      },
    });
  });

  it('accepts exactly the capabilities a grant turns on', () => {
    const grants: AcpAllowlist = {
      fake: {
        clientCapabilities: {
          terminal: true,
        },
      },
    };
    expectAccepted(
      {
        clientCapabilities: {
          terminal: true,
        },
      },
      grants,
    );
    expectRefused(
      {
        clientCapabilities: {
          readTextFile: true,
        },
      },
      grants,
    );
  });

  it('applies a grant only to its own agent, never one off the object prototype', () => {
    const fields = {
      agent: 'constructor',
      clientCapabilities: {
        terminal: true,
      },
    };
    expectRefused(fields, {
      fake: {
        clientCapabilities: {
          terminal: true,
        },
      },
    });
    expectRefused(fields, {});
  });
});

describe('checkAcpAgents — sessions', () => {
  it('accepts keepAlive up to "run" by default and refuses "harness"', () => {
    expectAccepted({
      session: {
        reuse: 'w',
        keepAlive: 'run',
      },
    });
    expectRefused({
      session: {
        reuse: 'main',
        keepAlive: 'harness',
      },
    });
    expectRefused(
      {
        session: {
          reuse: 'w',
          keepAlive: 'run',
        },
      },
      {
        fake: {
          session: {
            keepAlive: 'step',
          },
        },
      },
    );
  });

  it('refuses "harness" even from an untyped grant, since the run namespace dies with the run', () => {
    const untyped: AcpAllowlist = JSON.parse('{"fake":{"session":{"keepAlive":"harness"}}}');
    const message = expectRefused(
      {
        session: {
          reuse: 'main',
          keepAlive: 'harness',
        },
      },
      untyped,
    );
    expect(message).toContain('session.keepAlive "harness"');
    expect(acpPrompt(agents(recordingAgent()), untyped, CWD)).toContain('keepAlive up to "run"');
  });

  it('refuses session.load unless the grant allows it', () => {
    expectRefused({
      session: {
        load: 'victim-session',
      },
    });
    expectAccepted(
      {
        session: {
          load: 'victim-session',
        },
      },
      {
        fake: {
          session: {
            load: true,
          },
        },
      },
    );
  });

  it('checks acp-agent nodes inside an inline subflow', () => {
    expectCode(
      () =>
        checkAcpAgents(
          {
            version: 1,
            root: {
              kind: 'subflow',
              id: 'inner',
              document: docOf(
                agentNode({
                  session: {
                    load: 'x',
                  },
                }),
              ),
            },
          },
          undefined,
          CWD,
        ),
      'CONNECTION_NOT_ALLOWED',
    );
  });
});

describe('boundedAcpSettings', () => {
  it('fills omitted capabilities from the grant and moves the reuse key into the run namespace', () => {
    const bounds = acpBounds(undefined, CWD);
    const settings = boundedAcpSettings(
      agentNode({
        clientCapabilities: {
          readTextFile: false,
        },
        session: {
          reuse: 'main',
          keepAlive: 'run',
        },
      }),
      bounds,
    );
    expect(settings.clientCapabilities).toEqual({
      readTextFile: false,
      writeTextFile: false,
      terminal: false,
    });
    expect(settings.session).toEqual({
      reuse: `${bounds.sessionScope}/main`,
      keepAlive: 'run',
    });
    expect(acpBounds(undefined, CWD).sessionScope).not.toBe(bounds.sessionScope);
  });

  it('resolves an omitted cwd to the grant, else the harness cwd it was given', () => {
    const bounds = acpBounds(
      {
        fake: {
          cwd: '/sandbox',
        },
      },
      CWD,
    );
    expect(boundedAcpSettings(agentNode(), bounds).cwd).toBe('/sandbox');
    expect(
      boundedAcpSettings(
        agentNode({
          cwd: '/sandbox/x',
        }),
        bounds,
      ).cwd,
    ).toBe('/sandbox/x');
    expect(boundedAcpSettings(agentNode(), acpBounds(undefined, CWD)).cwd).toBe(CWD);
  });
});

describe('acpPrompt', () => {
  it('lists each registered agent with its limits', () => {
    const record = recordingAgent();
    const prompt = acpPrompt(
      agents(record),
      {
        fake: {
          permissions: {
            allow: [
              {
                kind: 'read',
              },
            ],
          },
          clientCapabilities: {
            terminal: true,
          },
          session: {
            keepAlive: 'run',
            load: true,
          },
          modes: [
            'default',
          ],
          models: [
            'opus',
          ],
        },
      },
      CWD,
    );
    expect(prompt).toContain('- "fake":');
    expect(prompt).toContain('"deny" only');
    expect(prompt).toContain('[{"kind":"read"}]');
    expect(prompt).toContain('cwd "/work"');
    expect(prompt).toContain('clientCapabilities terminal');
    expect(prompt).toContain('keepAlive up to "run", "load" allowed');
    expect(prompt).toContain('mode one of ["default"]');
    expect(prompt).toContain('model one of ["opus"]');
  });

  it('shows the narrowest defaults without a grant, and no agents without a registry', () => {
    const prompt = acpPrompt(agents(recordingAgent()), undefined, CWD);
    expect(prompt).toContain('clientCapabilities readTextFile');
    expect(prompt).toContain('keepAlive up to "run", no "load"');
    expect(prompt).toContain('no mode;');
    expect(prompt).toContain('any model;');
    expect(acpPrompt(undefined, undefined, CWD)).toContain('do not emit acp-agent nodes');
  });
});

describe('parseAndRunWorkflow — ACP agent grants', () => {
  async function run(
    document: WorkflowDocument,
    opts: {
      record?: AgentRecord;
      acp?: AcpAllowlist;
      harness?: AgentHarness;
    } = {},
  ): Promise<{
    output: string;
    record: AgentRecord;
  }> {
    const record = opts.record ?? recordingAgent();
    const harness = opts.harness ?? harnessAt(CWD);
    const output = await parseAndRunWorkflow({
      json: document,
      harness,
      ctx: harness.createContext(),
      tools: [],
      acpAgents: agents(record),
      acp: opts.acp,
    });
    return {
      output,
      record,
    };
  }

  it('refuses a document granting itself permissions, cwd or capabilities before the agent starts', async () => {
    for (const fields of [
      {
        permissions: {
          default: 'allow' as const,
        },
      },
      {
        cwd: '/',
      },
      {
        clientCapabilities: {
          terminal: true,
          writeTextFile: true,
        },
      },
    ]) {
      const record = recordingAgent();
      await expectConfig(
        run(docOf(agentNode(fields)), {
          record,
        }),
        'CONNECTION_NOT_ALLOWED',
      );
      expect(record.connects).toBe(0);
    }
  });

  it('refuses an ungranted mode before the agent starts, and sets a granted one', async () => {
    const node = agentNode({
      mode: 'bypassPermissions',
    });
    const refused = recordingAgent();
    await expectConfig(
      run(docOf(node), {
        record: refused,
      }),
      'CONNECTION_NOT_ALLOWED',
    );
    expect(refused.connects).toBe(0);
    const { record } = await run(docOf(node), {
      acp: {
        fake: {
          modes: [
            'bypassPermissions',
          ],
        },
      },
    });
    expect(record.modes).toEqual([
      'bypassPermissions',
    ]);
  });

  it('runs a node without cwd in the granted cwd, not the harness cwd', async () => {
    const { record } = await run(docOf(agentNode()), {
      acp: {
        fake: {
          cwd: '/sandbox',
        },
      },
    });
    expect(record.cwds).toEqual([
      '/sandbox',
    ]);
  });

  it('runs a node without cwd in the harness cwd read at parse, even if it moves before the step runs', async () => {
    const record = recordingAgent();
    const harness = harnessAt(CWD);
    const ctx = harness.createContext();
    await parseAndRunWorkflow({
      json: docOf(
        agentNode({
          id: 'first',
        }),
        agentNode({
          id: 'second',
        }),
      ),
      harness,
      ctx,
      tools: [],
      acpAgents: new Map([
        [
          'fake',
          {
            ...record.agent,
            async connect(opts) {
              // The first agent turn moves the harness cwd out of bounds.
              ctx.cwdState.cwd = '/';
              return record.agent.connect(opts);
            },
          },
        ],
      ]),
    });
    expect(ctx.cwdState.cwd).toBe('/');
    expect(record.cwds).toEqual([
      CWD,
      CWD,
    ]);
  });

  it('opens the agent with only the granted capabilities when the node names none', async () => {
    const { output, record } = await run(docOf(agentNode()));
    expect(output).toBe('agent done');
    expect(record.capabilities).toEqual([
      {
        readTextFile: true,
        writeTextFile: false,
        terminal: false,
      },
    ]);
    expect(record.permissions).toEqual([
      undefined,
    ]);
  });

  it('refuses session.load unless granted, and loads the session when it is', async () => {
    const node = agentNode({
      session: {
        load: 'victim-session',
      },
    });
    const refused = recordingAgent();
    await expectConfig(
      run(docOf(node), {
        record: refused,
      }),
      'CONNECTION_NOT_ALLOWED',
    );
    expect(refused.connects).toBe(0);
    const { record } = await run(docOf(node), {
      acp: {
        fake: {
          session: {
            load: true,
          },
        },
      },
    });
    expect(record.loads).toEqual([
      'victim-session',
    ]);
  });

  it('never joins a host session, even under the same reuse key', async () => {
    const record = recordingAgent();
    const harness = harnessAt(CWD);
    await harness.run(
      step.acpAgent({
        id: 'host',
        agent: record.agent,
        prompt: 'host turn',
        session: {
          reuse: 'main',
          keepAlive: 'harness',
        },
      }),
      'x',
      harness.createContext(),
    );
    const sessionNode = agentNode({
      id: 'doc',
      session: {
        reuse: 'main',
        keepAlive: 'harness',
      },
    });
    await expectConfig(
      run(docOf(sessionNode), {
        record,
        harness,
      }),
      'CONNECTION_NOT_ALLOWED',
    );
    expect(record.connects).toBe(1);
    await run(
      docOf(
        agentNode({
          id: 'doc',
          session: {
            reuse: 'main',
            keepAlive: 'run',
          },
        }),
      ),
      {
        record,
        harness,
      },
    );
    // The document opened its own connection rather than taking the host's,
    // and its session ended with its run.
    expect(record.connects).toBe(2);
    expect(harness.listAcpSessions().map((s) => s.reuseKey)).toEqual([
      'main',
    ]);
    await harness.closeAcpSessions();
  });

  it('still shares one session between two nodes of the same document', async () => {
    const shared = {
      reuse: 'w',
      keepAlive: 'run' as const,
    };
    const { record } = await run(
      docOf(
        agentNode({
          id: 'first',
          session: shared,
        }),
        agentNode({
          id: 'second',
          session: shared,
        }),
      ),
    );
    expect(record.connects).toBe(1);
    expect(record.permissions.length).toBe(2);
  });

  it('does not hold a named subflow ref, which the host wrote, to the grants', async () => {
    const record = recordingAgent();
    const harness = harnessAt(CWD);
    await parseAndRunWorkflow({
      json: {
        version: 1,
        root: {
          kind: 'subflow',
          id: 'host-flow',
          ref: 'trusted',
        },
      },
      harness,
      ctx: harness.createContext(),
      tools: [],
      acpAgents: agents(record),
      workflows: new Map([
        [
          'trusted',
          docOf(agentNode()),
        ],
      ]),
    });
    expect(record.capabilities).toEqual([
      undefined,
    ]);
  });
});

describe('dynamicWorkflow — ACP agent grants', () => {
  function plannerHarness(document: WorkflowDocument, requests: CallModelRequest[]): AgentHarness {
    return new AgentHarness({
      name: 'planner',
      params: {},
      initialCwd: CWD,
      _testCallModel: async (request) => {
        requests.push(request);
        return makeLLMResponse(JSON.stringify(document));
      },
    });
  }

  it('shows the planner the registered agents and their limits, and refuses a self-granting document', async () => {
    const record = recordingAgent();
    const requests: CallModelRequest[] = [];
    const harness = plannerHarness(
      docOf(
        agentNode({
          clientCapabilities: {
            terminal: true,
          },
        }),
      ),
      requests,
    );
    await expectConfig(
      harness.run(
        dynamicWorkflow({
          tools: [],
          maxRevisions: 2,
          acpAgents: agents(record),
        }),
        'do it',
        harness.createContext(),
      ),
      'CONNECTION_NOT_ALLOWED',
    );
    expect(record.connects).toBe(0);
    const prompt = JSON.stringify(requests[0]);
    expect(prompt).toContain('- \\"fake\\":');
    expect(prompt).toContain('clientCapabilities readTextFile');
    expect(JSON.stringify(requests[1])).toContain('clientCapabilities.terminal');
    await harness.close();
  });
});
