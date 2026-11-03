/**
 * Agents that cannot take tools yet say which fix they are missing, and a
 * step that gives them tools or connections fails before anything spawns.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { connectionTools, step, tool } from '@noetic-tools/core';
import type { AcpAgent } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { claudeCode, codex, customAcpAgent, gemini, opencode, pi } from '../src/agents';
import { defineAcpAgent } from '../src/define';
import { loopbackTransport } from '../src/transport-loopback';

const echo = tool({
  name: 'echo',
  description: 'Echo the text.',
  input: z.object({
    text: z.string(),
  }),
  output: z.string(),
  execute: async ({ text }) => text,
});

const neverConnects = loopbackTransport(() => {
  throw new Error('the agent must not start');
});

function refusalOf(agent: AcpAgent, given: 'tool' | 'pick'): unknown {
  try {
    step.acpAgent({
      id: 'refused',
      agent,
      prompt: 'go',
      tools: [
        given === 'tool' ? echo : connectionTools('docs'),
      ],
    });
    return undefined;
  } catch (e) {
    return e;
  }
}

describe('which agents take tools', () => {
  it('an attached transport cannot launch when its wiring has launch settings, else cannot reach', () => {
    const claude = refusalOf(
      claudeCode({
        transport: neverConnects,
      }),
      'tool',
    );
    assert(isNoeticConfigError(claude));
    expect(claude.code).toBe('ACP_TRANSPORT_CANNOT_LAUNCH');
    expect(claude.message).toContain('launch()');

    const custom = refusalOf(
      customAcpAgent({
        agentId: 'remote',
        transport: neverConnects,
      }),
      'pick',
    );
    assert(isNoeticConfigError(custom));
    expect(custom.code).toBe('ACP_TRANSPORT_CANNOT_REACH');
    expect(custom.message).toContain('reach()');
    expect(custom.message).not.toContain('launch()');
  });

  it('every preset and a custom agent with a command take tools', () => {
    for (const agent of [
      claudeCode(),
      codex(),
      gemini({
        trustWorkspace: true,
      }),
      gemini({
        env: {
          GEMINI_CLI_TRUST_WORKSPACE: 'true',
        },
      }),
      opencode(),
      pi(),
      customAcpAgent({
        agentId: 'custom',
        command: 'custom-acp',
      }),
    ]) {
      expect(agent.refusesTools).toBeUndefined();
      expect(refusalOf(agent, 'tool')).toBeUndefined();
    }
  });

  it('Gemini in an untrusted folder refuses tools before it starts, naming trustWorkspace', () => {
    const agent = gemini();
    expect(agent.refusesTools?.code).toBe('ACP_AGENT_CANNOT_TAKE_TOOLS');
    for (const given of [
      'tool',
      'pick',
    ] as const) {
      const refusal = refusalOf(agent, given);
      assert(isNoeticConfigError(refusal));
      expect(refusal.code).toBe('ACP_AGENT_CANNOT_TAKE_TOOLS');
      expect(refusal.message).toContain("'gemini' agent");
      expect(refusal.message).toContain('does not trust');
      expect(refusal.hint).toContain('gemini({ trustWorkspace: true })');
    }
    // Without tools it runs as before.
    expect(() =>
      step.acpAgent({
        id: 'plain',
        agent,
        prompt: 'go',
      }),
    ).not.toThrow();
  });

  it('Gemini on a transport refuses tools for the transport', () => {
    const refusal = refusalOf(
      gemini({
        transport: neverConnects,
        trustWorkspace: false,
      }),
      'tool',
    );
    assert(isNoeticConfigError(refusal));
    expect(refusal.code).toBe('ACP_TRANSPORT_CANNOT_REACH');
  });

  it('an agent defined on a transport refuses tools', () => {
    const agent = defineAcpAgent({
      agentId: 'attached',
      transport: neverConnects,
    });
    expect(agent.refusesTools?.code).toBe('ACP_TRANSPORT_CANNOT_REACH');
  });
});
