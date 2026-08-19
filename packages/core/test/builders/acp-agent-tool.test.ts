/**
 * `acpAgentTool` — handing an ACP coding agent to a model as a callable tool.
 *
 * The agent is a hand-built implementation of the `AcpAgent` contract, which is
 * all core ever sees; the real protocol is covered in `packages/acp`.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpAgent,
  AcpAgentConnection,
  AcpPromptOptions,
  AcpSession,
  AcpTurnResult,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import { acpAgentTool } from '../../src/builders/acp-agent-tool';
import { AgentHarness } from '../../src/harness/agent-harness';
import { makeMessage } from '../_helpers';

//#region Fake agent

interface FakeAgentOpts {
  agentId?: string;
  /** Answers derived from the prompt, so a test can prove the argument arrived. */
  reply?: (prompt: string) => string;
  onConnect?: () => void;
  onPrompt?: (opts: AcpPromptOptions) => void;
}

function fakeAgent(opts: FakeAgentOpts = {}): AcpAgent {
  const agentId = opts.agentId ?? 'claude-code';
  const reply = opts.reply ?? (() => 'done');
  return {
    specificationVersion: 'acp-v1',
    agentId,
    async connect(): Promise<AcpAgentConnection> {
      opts.onConnect?.();
      const session: AcpSession = {
        sessionId: 'session-1',
        availableCommands: [],
        async prompt(prompt): Promise<AcpTurnResult> {
          opts.onPrompt?.(prompt);
          const text = reply(prompt.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
          return {
            stopReason: 'end_turn',
            items: [
              makeMessage('assistant', text),
            ],
            text,
          };
        },
        async cancel() {
          // Nothing in flight in the fake.
        },
        async setMode() {
          // No modes in the fake.
        },
        async setModel() {
          // No models in the fake.
        },
      };
      return {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: 1,
        async authenticate() {
          // No auth in the fake.
        },
        async newSession() {
          return session;
        },
        async loadSession() {
          return session;
        },
        async close() {
          // No resources in the fake.
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

/** Invoke a tool the way the model-call path does. */
async function callTool(
  toolDef: ReturnType<typeof acpAgentTool>,
  prompt: string,
  rig: ReturnType<typeof harnessCtx>,
): Promise<{
  text: string;
}> {
  const result = await toolDef.execute(
    {
      prompt,
    },
    frameworkCast({
      ctx: rig.ctx,
      harness: rig.harness,
      fs: rig.ctx.fs,
      shell: rig.ctx.shell,
      context: {
        get: () => undefined,
        set: () => undefined,
      },
      assembledView: [],
      lastStepMeta: null,
    }),
  );
  return frameworkCast(result);
}

//#endregion

describe('acpAgentTool', () => {
  it('names itself after the agent by default', () => {
    expect(
      acpAgentTool({
        agent: fakeAgent({
          agentId: 'claude-code',
        }),
      }).name,
    ).toBe('delegate_to_claude_code');
  });

  it('accepts an explicit name and description', () => {
    const built = acpAgentTool({
      agent: fakeAgent(),
      name: 'ask_the_coder',
      description: 'Custom guidance about when to delegate.',
    });
    expect(built.name).toBe('ask_the_coder');
    expect(built.description).toBe('Custom guidance about when to delegate.');
  });

  it("passes the model's argument through as the agent's prompt", async () => {
    const rig = harnessCtx();
    let seen = '';
    const built = acpAgentTool({
      agent: fakeAgent({
        onPrompt: (p) => {
          seen = p.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        },
        reply: (prompt) => `handled: ${prompt}`,
      }),
    });

    const result = await callTool(built, 'refactor the parser', rig);

    expect(seen).toContain('refactor the parser');
    expect(result.text).toContain('refactor the parser');
  });

  it("folds the delegated turn into the caller's item log and usage", async () => {
    const rig = harnessCtx();
    const built = acpAgentTool({
      agent: fakeAgent({
        reply: () => 'delegated answer',
      }),
    });

    await callTool(built, 'do the thing', rig);

    // A real step ran: the prompt and the answer are both in the log.
    const texts = rig.ctx.itemLog.items
      .filter((i) => i.type === 'message')
      .flatMap((i) => i.content.map((c) => ('text' in c ? c.text : '')));
    expect(texts).toContain('do the thing');
    expect(texts).toContain('delegated answer');
  });

  it('opens one connection per call by default', async () => {
    const rig = harnessCtx();
    let connects = 0;
    const built = acpAgentTool({
      agent: fakeAgent({
        onConnect: () => {
          connects++;
        },
      }),
    });

    await callTool(built, 'one', rig);
    await callTool(built, 'two', rig);

    expect(connects).toBe(2);
  });

  it('shares one session across calls when the session policy says so', async () => {
    const rig = harnessCtx();
    let connects = 0;
    const built = acpAgentTool({
      agent: fakeAgent({
        onConnect: () => {
          connects++;
        },
      }),
      session: {
        reuse: 'delegate',
        keepAlive: 'harness',
      },
    });

    await callTool(built, 'one', rig);
    await callTool(built, 'two', rig);

    // The model held a conversation with the agent rather than starting cold.
    expect(connects).toBe(1);
    await rig.harness.closeAcpSessions();
  });

  it('rejects a missing agent adapter', () => {
    try {
      acpAgentTool({
        agent: frameworkCast<AcpAgent>(undefined),
      });
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_ACP_AGENT');
    }
  });
});
