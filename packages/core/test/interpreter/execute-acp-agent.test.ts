/**
 * Interpreter-level tests for the ACP step handler.
 *
 * The agent here is a hand-built implementation of the `AcpAgent` contract
 * rather than a real protocol client — core resolves agents only through that
 * contract (and is forbidden by `.sentrux/rules.toml` from importing
 * `@noetic-tools/acp`), so testing against it is testing exactly the seam core
 * owns. Real wire-protocol behaviour is covered in `packages/acp`.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpAgent,
  AcpAgentConnection,
  AcpClientHost,
  AcpContentBlock,
  AcpNewSessionOptions,
  AcpPromptOptions,
  AcpSession,
  AcpSessionModeState,
  AcpSessionNotification,
  AcpStopReason,
  AcpTurnResult,
  Item,
  TokenUsage,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { step } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { makeMessage } from '../_helpers';

//#region Fake agent

interface FakeAgentOpts {
  agentId?: string;
  text?: string;
  items?: Item[];
  usage?: TokenUsage | null;
  cost?: number;
  stopReason?: AcpStopReason;
  modes?: AcpSessionModeState;
  /** Notifications the agent pushes during the turn. */
  updates?: AcpSessionNotification[];
  onConnect?: (host: AcpClientHost) => void;
  onNewSession?: (opts: AcpNewSessionOptions) => void;
  onPrompt?: (opts: AcpPromptOptions) => void;
  onClose?: () => void;
  onSetMode?: (modeId: string) => void;
  throwOnTurn?: Error;
  throwOnNewSession?: Error;
  throwOnSetMode?: Error;
}

function fakeAgent(opts: FakeAgentOpts = {}): AcpAgent {
  const text = opts.text ?? 'done';
  const agentId = opts.agentId ?? 'claude-code';
  let sessionCounter = 0;

  return {
    specificationVersion: 'acp-v1',
    agentId,
    async connect(connect): Promise<AcpAgentConnection> {
      opts.onConnect?.(connect.host);
      const makeSession = (sessionId: string): AcpSession => ({
        sessionId,
        modes: opts.modes,
        availableCommands: [],
        async prompt(prompt): Promise<AcpTurnResult> {
          opts.onPrompt?.(prompt);
          if (opts.throwOnTurn) {
            throw opts.throwOnTurn;
          }
          for (const update of opts.updates ?? []) {
            connect.host.onSessionUpdate(update);
          }
          return {
            stopReason: opts.stopReason ?? 'end_turn',
            items: opts.items ?? [
              makeMessage('assistant', text),
            ],
            text,
            usage:
              opts.usage === null
                ? undefined
                : (opts.usage ?? {
                    input: 10,
                    output: 5,
                    total: 15,
                  }),
            cost: opts.cost,
          };
        },
        async cancel() {
          // No in-flight work to interrupt in the fake.
        },
        async setMode(modeId) {
          opts.onSetMode?.(modeId);
          if (opts.throwOnSetMode) {
            throw opts.throwOnSetMode;
          }
        },
        async setModel() {
          // Model selection is a no-op in the fake.
        },
      });

      return {
        agentCapabilities: {
          loadSession: true,
        },
        authMethods: [],
        protocolVersion: 1,
        async authenticate() {
          // No auth in the fake.
        },
        async newSession(newSession) {
          opts.onNewSession?.(newSession);
          if (opts.throwOnNewSession) {
            throw opts.throwOnNewSession;
          }
          sessionCounter += 1;
          return makeSession(`session-${sessionCounter}`);
        },
        async loadSession(load) {
          return makeSession(load.sessionId);
        },
        async close() {
          opts.onClose?.();
        },
      };
    },
  };
}

function harnessCtx() {
  const harness = new AgentHarness({
    name: 'test',
    params: {},
  });
  return {
    harness,
    ctx: harness.createContext(),
  };
}

function messageTexts(ctx: ReturnType<typeof harnessCtx>['ctx']): string[] {
  return ctx.itemLog.items
    .filter((i) => i.type === 'message')
    .flatMap((i) => i.content.map((c) => ('text' in c ? c.text : '')));
}

//#endregion

describe('executeAcpAgent', () => {
  it('runs a turn: appends items, tracks usage, sets lastStepMeta, returns text', async () => {
    const { ctx } = harnessCtx();
    const acpStep = step.acpAgent({
      id: 'review',
      agent: fakeAgent({
        text: 'reviewed',
        cost: 0.002,
      }),
      prompt: 'review the diff',
    });

    const result = await execute(acpStep, undefined, ctx);

    expect(result).toBe('reviewed');
    const texts = messageTexts(ctx);
    expect(texts).toContain('review the diff');
    expect(texts).toContain('reviewed');
    expect(ctx.tokens.total).toBe(15);
    expect(ctx.cost).toBeCloseTo(0.002, 6);
    assert(ctx.lastStepMeta);
    assert(ctx.lastStepMeta.usage);
    expect(ctx.lastStepMeta.usage.inputTokens).toBe(10);
  });

  it('parses structured output through the step schema', async () => {
    const { ctx } = harnessCtx();
    const acpStep = step.acpAgent({
      id: 'extract',
      agent: fakeAgent({
        agentId: 'codex',
        text: '{"ok":true,"count":3}',
      }),
      prompt: 'extract',
      output: z.object({
        ok: z.boolean(),
        count: z.number(),
      }),
    });

    const result = await execute(acpStep, undefined, ctx);

    expect(result).toEqual({
      ok: true,
      count: 3,
    });
  });

  it('uses string input as the prompt when prompt resolves empty', async () => {
    const { ctx } = harnessCtx();
    const acpStep = step.acpAgent({
      id: 'from-input',
      agent: fakeAgent(),
      prompt: '',
    });

    await execute(acpStep, 'prompt-from-input', ctx);

    expect(messageTexts(ctx)).toContain('prompt-from-input');
  });

  it('seeds a fresh session with the conversation so far', async () => {
    const { ctx } = harnessCtx();
    ctx.itemLog.append(makeMessage('user', 'what is the bug?'));
    ctx.itemLog.append(makeMessage('assistant', 'a null deref in parse()'));
    let sent: ReadonlyArray<AcpContentBlock> = [];
    const acpStep = step.acpAgent({
      id: 'fix',
      agent: fakeAgent({
        onPrompt: (p) => {
          sent = p.content;
        },
      }),
      prompt: 'fix it',
    });

    await execute(acpStep, undefined, ctx);

    const firstBlock = sent[0];
    assert(firstBlock && firstBlock.type === 'text');
    expect(firstBlock.text).toContain('Conversation so far:');
    expect(firstBlock.text).toContain('a null deref in parse()');
    expect(firstBlock.text).toContain('Current request:\nfix it');
  });

  it('does not add a history preamble on the first step of a run', async () => {
    const { ctx } = harnessCtx();
    let sent: ReadonlyArray<AcpContentBlock> = [];
    const acpStep = step.acpAgent({
      id: 'first',
      agent: fakeAgent({
        onPrompt: (p) => {
          sent = p.content;
        },
      }),
      prompt: 'go',
    });

    await execute(acpStep, undefined, ctx);

    const firstBlock = sent[0];
    assert(firstBlock && firstBlock.type === 'text');
    expect(firstBlock.text).toBe('go');
  });

  it('appends explicit content blocks after the prompt text', async () => {
    const { ctx } = harnessCtx();
    let sent: ReadonlyArray<AcpContentBlock> = [];
    const acpStep = step.acpAgent({
      id: 'multimodal',
      agent: fakeAgent({
        onPrompt: (p) => {
          sent = p.content;
        },
      }),
      prompt: 'describe this',
      content: [
        {
          type: 'image',
          data: 'AAAA',
          mimeType: 'image/png',
        },
      ],
    });

    await execute(acpStep, undefined, ctx);

    expect(sent).toHaveLength(2);
    expect(sent[0]?.type).toBe('text');
    expect(sent[1]?.type).toBe('image');
  });

  it('switches session mode before prompting when a mode is given', async () => {
    const { ctx } = harnessCtx();
    const seen: string[] = [];
    const acpStep = step.acpAgent({
      id: 'planned',
      agent: fakeAgent({
        modes: {
          currentModeId: 'default',
          availableModes: [
            {
              id: 'default',
              name: 'Default',
              description: null,
            },
            {
              id: 'plan',
              name: 'Plan',
              description: null,
            },
          ],
        },
        onSetMode: (modeId) => {
          seen.push(modeId);
        },
        onPrompt: () => {
          seen.push('prompt');
        },
      }),
      prompt: 'go',
      mode: 'plan',
    });

    await execute(acpStep, undefined, ctx);

    expect(seen).toEqual([
      'plan',
      'prompt',
    ]);
  });

  it('passes MCP servers through to session creation', async () => {
    const { ctx } = harnessCtx();
    let seen: AcpNewSessionOptions | undefined;
    const acpStep = step.acpAgent({
      id: 'with-mcp',
      agent: fakeAgent({
        onNewSession: (o) => {
          seen = o;
        },
      }),
      prompt: 'go',
      mcpServers: [
        {
          name: 'db',
          command: 'mcp-db',
          args: [],
          env: [],
        },
      ],
    });

    await execute(acpStep, undefined, ctx);

    expect(seen?.mcpServers).toHaveLength(1);
  });
});

describe('executeAcpAgent — session lifecycle', () => {
  it('closes a fresh connection when the step completes', async () => {
    const { ctx } = harnessCtx();
    let closes = 0;
    const acpStep = step.acpAgent({
      id: 'one-shot',
      agent: fakeAgent({
        onClose: () => {
          closes++;
        },
      }),
      prompt: 'go',
    });

    await execute(acpStep, undefined, ctx);

    expect(closes).toBe(1);
  });

  it('reuses one connection across steps when session.reuse is set', async () => {
    const { ctx } = harnessCtx();
    let connects = 0;
    let closes = 0;
    const agent = fakeAgent({
      onConnect: () => {
        connects++;
      },
      onClose: () => {
        closes++;
      },
    });
    const first = step.acpAgent({
      id: 'a',
      agent,
      prompt: 'one',
      session: {
        reuse: 'shared',
      },
    });
    const second = step.acpAgent({
      id: 'b',
      agent,
      prompt: 'two',
      session: {
        reuse: 'shared',
      },
    });

    await execute(first, undefined, ctx);
    await execute(second, undefined, ctx);

    expect(connects).toBe(1);
    expect(closes).toBe(0);
  });

  it("onComplete: 'close' tears down a reused session and drops it from the store", async () => {
    const { ctx } = harnessCtx();
    let connects = 0;
    let closes = 0;
    const agent = fakeAgent({
      onConnect: () => {
        connects++;
      },
      onClose: () => {
        closes++;
      },
    });
    const first = step.acpAgent({
      id: 'a',
      agent,
      prompt: 'one',
      session: {
        reuse: 'shared',
        onComplete: 'close',
      },
    });
    const second = step.acpAgent({
      id: 'b',
      agent,
      prompt: 'two',
      session: {
        reuse: 'shared',
      },
    });

    await execute(first, undefined, ctx);
    await execute(second, undefined, ctx);

    expect(closes).toBe(1);
    expect(connects).toBe(2);
  });

  it('resumes an existing ACP session id via session.load', async () => {
    const { ctx } = harnessCtx();
    let newSessions = 0;
    const acpStep = step.acpAgent({
      id: 'resumed',
      agent: fakeAgent({
        onNewSession: () => {
          newSessions++;
        },
      }),
      prompt: 'continue',
      session: {
        load: 'session-from-yesterday',
      },
    });

    await execute(acpStep, undefined, ctx);

    expect(newSessions).toBe(0);
  });
});

describe('executeAcpAgent — a session shared across steps', () => {
  // Regression: the client host carries the per-turn policy, steering hook, and
  // event sink, but it is created once when the connection opens. Leaving it
  // bound to the opening step made every later step answer permissions with the
  // FIRST step's policy and stream its output to the first step's (already
  // finalized) event bridge — silently, and in the documented
  // "investigate read-only, then fix with edits" pattern.
  async function runTwoSteps(): Promise<{
    host: AcpClientHost;
    closes: number;
  }> {
    const { ctx } = harnessCtx();
    let host: AcpClientHost | undefined;
    let closes = 0;
    const agent = fakeAgent({
      onConnect: (h) => {
        host = h;
      },
      onClose: () => {
        closes++;
      },
    });

    const investigate = step.acpAgent({
      id: 'investigate',
      agent,
      prompt: 'look',
      permissions: {
        default: 'deny',
      },
      session: {
        reuse: 'shared',
      },
    });
    const fix = step.acpAgent({
      id: 'fix',
      agent,
      prompt: 'edit',
      permissions: {
        allow: [
          {
            kind: 'edit',
          },
        ],
      },
      session: {
        reuse: 'shared',
      },
    });

    await execute(investigate, undefined, ctx);
    await execute(fix, undefined, ctx);
    assert(host);
    return {
      host,
      closes,
    };
  }

  it("rebinds the host to the current step's permission policy", async () => {
    const { host } = await runTwoSteps();

    // The second step's broader policy must be in force, not the opener's deny.
    expect(host.permissions?.default).toBeUndefined();
    expect(host.permissions?.allow).toEqual([
      {
        kind: 'edit',
      },
    ]);
  });

  it("routes session updates to the current step's event bridge", async () => {
    const { ctx } = harnessCtx();
    let host: AcpClientHost | undefined;
    const agent = fakeAgent({
      onConnect: (h) => {
        host = h;
      },
    });
    const first = step.acpAgent({
      id: 'first',
      agent,
      prompt: 'one',
      session: {
        reuse: 'shared',
      },
    });
    await execute(first, undefined, ctx);
    assert(host);
    const afterFirst = host.onSessionUpdate;

    const second = step.acpAgent({
      id: 'second',
      agent,
      prompt: 'two',
      session: {
        reuse: 'shared',
      },
    });
    await execute(second, undefined, ctx);

    // A fresh sink per turn is what carries the correct stepId downstream.
    expect(host.onSessionUpdate).not.toBe(afterFirst);
  });

  it('reuses one connection but keeps it open between steps', async () => {
    const { closes } = await runTwoSteps();
    expect(closes).toBe(0);
  });

  // Regression: `onComplete: 'keep'` used to mean "keep forever" — nothing ever
  // emptied the harness's session store. With the stdio transport that leaves a
  // child process running whose stdio keeps the event loop alive, so the host
  // never exits. Reuse is scoped to the root run.
  it('closes a kept session when the root run finishes', async () => {
    const { harness } = harnessCtx();
    let closes = 0;
    const agent = fakeAgent({
      onClose: () => {
        closes++;
      },
    });
    const kept = step.acpAgent({
      id: 'kept',
      agent,
      prompt: 'go',
      session: {
        reuse: 'shared',
        onComplete: 'keep',
      },
    });

    const ctx = harness.createContext();
    await harness.run(kept, undefined, ctx);

    expect(closes).toBe(1);
  });

  it('rejects reusing a session key across two different agents', async () => {
    const { ctx } = harnessCtx();
    const first = step.acpAgent({
      id: 'a',
      agent: fakeAgent({
        agentId: 'claude-code',
      }),
      prompt: 'one',
      session: {
        reuse: 'shared',
      },
    });
    const second = step.acpAgent({
      id: 'b',
      agent: fakeAgent({
        agentId: 'codex',
      }),
      prompt: 'two',
      session: {
        reuse: 'shared',
      },
    });

    await execute(first, undefined, ctx);
    try {
      await execute(second, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('ACP_SESSION_AGENT_CONFLICT');
    }
  });

  it('rejects reusing a session with different clientCapabilities', async () => {
    const { ctx } = harnessCtx();
    const agent = fakeAgent();
    const first = step.acpAgent({
      id: 'a',
      agent,
      prompt: 'one',
      clientCapabilities: {
        writeTextFile: false,
      },
      session: {
        reuse: 'shared',
      },
    });
    const second = step.acpAgent({
      id: 'b',
      agent,
      prompt: 'two',
      clientCapabilities: {
        writeTextFile: true,
      },
      session: {
        reuse: 'shared',
      },
    });

    await execute(first, undefined, ctx);
    try {
      await execute(second, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('ACP_SESSION_CAPABILITY_CONFLICT');
    }
  });
});

describe('executeAcpAgent — stop reasons and errors', () => {
  it("throws kind 'model_refused' when the agent refuses", async () => {
    const { ctx } = harnessCtx();
    const acpStep = step.acpAgent({
      id: 'refused',
      agent: fakeAgent({
        stopReason: 'refusal',
        text: 'I will not do that',
      }),
      prompt: 'go',
    });

    try {
      await execute(acpStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('model_refused');
    }
  });

  it("throws kind 'cancelled' when the agent reports a cancelled turn", async () => {
    const { ctx } = harnessCtx();
    const acpStep = step.acpAgent({
      id: 'cancelled',
      agent: fakeAgent({
        stopReason: 'cancelled',
      }),
      prompt: 'go',
    });

    try {
      await execute(acpStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('cancelled');
    }
  });

  it.each([
    'end_turn',
    'max_tokens',
    'max_turn_requests',
  ] as const)('returns normally on the %s stop reason', async (stopReason) => {
    const { ctx } = harnessCtx();
    const acpStep = step.acpAgent({
      id: `stop-${stopReason}`,
      agent: fakeAgent({
        stopReason,
        text: 'partial',
      }),
      prompt: 'go',
    });

    const result = await execute(acpStep, undefined, ctx);

    expect(result).toBe('partial');
  });

  it("throws kind 'step_failed' and closes the connection when the turn throws", async () => {
    const { ctx } = harnessCtx();
    let closes = 0;
    const acpStep = step.acpAgent({
      id: 'boom',
      agent: fakeAgent({
        throwOnTurn: new Error('agent crashed'),
        onClose: () => {
          closes++;
        },
      }),
      prompt: 'go',
    });

    try {
      await execute(acpStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
    }
    expect(closes).toBe(1);
  });

  // Regression: a connection owns a live agent (usually a child process) whose
  // stdio keeps the host's event loop alive. Failing to close it after a failed
  // session setup does not just leak — it hangs the process forever.
  it('closes the connection when session creation fails', async () => {
    const { ctx } = harnessCtx();
    let closes = 0;
    const acpStep = step.acpAgent({
      id: 'bad-session',
      agent: fakeAgent({
        throwOnNewSession: new Error('agent refused to open a session'),
        onClose: () => {
          closes++;
        },
      }),
      prompt: 'go',
    });

    try {
      await execute(acpStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      expect(String(e)).toContain('agent refused to open a session');
    }
    expect(closes).toBe(1);
  });

  it('closes the connection when mode selection fails', async () => {
    const { ctx } = harnessCtx();
    let closes = 0;
    const acpStep = step.acpAgent({
      id: 'bad-mode',
      agent: fakeAgent({
        modes: {
          currentModeId: 'default',
          availableModes: [
            {
              id: 'default',
              name: 'Default',
              description: null,
            },
          ],
        },
        throwOnSetMode: new Error('unknown mode'),
        onClose: () => {
          closes++;
        },
      }),
      prompt: 'go',
      mode: 'nonexistent',
    });

    try {
      await execute(acpStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      expect(String(e)).toContain('unknown mode');
    }
    expect(closes).toBe(1);
  });

  it('throws MISSING_ACP_AGENT when the adapter resolves to nothing', async () => {
    const { ctx } = harnessCtx();
    const acpStep = step.acpAgent({
      id: 'no-agent',
      agent: () => frameworkCast<AcpAgent>(undefined),
      prompt: 'go',
    });

    try {
      await execute(acpStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_ACP_AGENT');
    }
  });

  it('throws MISSING_PROMPT when neither a prompt nor content resolves', async () => {
    const { ctx } = harnessCtx();
    const acpStep = step.acpAgent({
      id: 'empty',
      agent: fakeAgent(),
      prompt: () => '   ',
    });

    try {
      await execute(acpStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_PROMPT');
    }
  });
});

describe('step.acpAgent builder validation', () => {
  it('rejects an empty id', () => {
    try {
      step.acpAgent({
        id: '  ',
        agent: fakeAgent(),
        prompt: 'go',
      });
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('EMPTY_STEP_ID');
    }
  });

  it('rejects a missing agent adapter', () => {
    try {
      step.acpAgent({
        id: 'x',
        agent: frameworkCast<AcpAgent>(undefined),
        prompt: 'go',
      });
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_ACP_AGENT');
    }
  });

  it('rejects a step with neither prompt nor content', () => {
    try {
      step.acpAgent({
        id: 'x',
        agent: fakeAgent(),
      });
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_PROMPT');
    }
  });
});
