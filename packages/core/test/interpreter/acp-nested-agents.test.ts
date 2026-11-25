/**
 * An agent step's subagents as nested agents (spec 08 § Nested agents,
 * spec 27 § Subagents): the event bridge's side.
 */

import { describe, expect, it } from 'bun:test';
import type {
  AcpAgent,
  AcpAgentConnection,
  AcpChildUpdate,
  AcpSession,
  AcpTurnResult,
  AgentScope,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { step } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { AcpEventBridge } from '../../src/interpreter/acp-events';
import { execute } from '../../src/interpreter/execute';
import { makeMessage } from '../_helpers';

interface Captured {
  type: string;
  data: Record<string, unknown>;
  scope?: AgentScope;
}

function bridge(): {
  events: Captured[];
  bridge: AcpEventBridge;
} {
  const harness = new AgentHarness({
    name: 'h',
    params: {},
  });
  const ctx = harness.createContext();
  const events: Captured[] = [];
  frameworkCast<{
    _broadcaster: unknown;
  }>(ctx)._broadcaster = {
    emit(event: Captured) {
      events.push(event);
    },
  };
  return {
    events,
    bridge: new AcpEventBridge(
      {
        id: 'step',
      },
      'claude-code',
      ctx,
    ),
  };
}

function announce(child: string, state?: Record<string, unknown>): AcpChildUpdate {
  return {
    sessionId: child,
    parentSessionId: 'root',
    announcement: true,
    update: {
      sessionUpdate: 'subagent_update',
      sessionId: child,
      title: 'Explore',
      ...(state
        ? {
            state: frameworkCast<{
              state: 'running';
            }>(state),
          }
        : {}),
    },
  };
}

function own(child: string, update: AcpChildUpdate['update']): AcpChildUpdate {
  return {
    sessionId: child,
    parentSessionId: 'root',
    announcement: false,
    update,
  };
}

const RESULT = {
  stopReason: 'end_turn' as const,
  items: [],
  text: '',
};

function lifecycle(events: Captured[]): string[] {
  return events
    .filter((e) => /:agent_(started|status|completed)$/.test(e.type))
    .map((e) => `${e.type.split(':')[1]}:${String(e.data.status ?? '')}`);
}

describe('nested agents on the event bridge', () => {
  it('opens nothing for an update that arrives after the turn ended', () => {
    const { bridge: b, events } = bridge();
    b.begin();
    b.forwardChild(announce('c1'));
    b.finalize(RESULT);
    b.forwardChild(announce('c2'));
    b.forwardChild(
      own('c1', {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'late',
        },
      }),
    );
    expect(lifecycle(events)).toEqual([
      'agent_started:',
      'agent_completed:completed',
    ]);
    expect(JSON.stringify(events)).not.toContain('late');
  });

  it('a child running again forgets its earlier stop', () => {
    const { bridge: b, events } = bridge();
    b.begin();
    b.forwardChild(
      announce('c1', {
        state: 'idle',
        stopReason: 'error',
      }),
    );
    b.forwardChild(
      announce('c1', {
        state: 'running',
      }),
    );
    b.finalize(RESULT);
    expect(lifecycle(events).at(-1)).toBe('agent_completed:completed');
  });

  it("names a nested agent by its scope alone, never the adapter's id", () => {
    const { bridge: b, events } = bridge();
    b.begin();
    b.forwardChild(announce('c1'));
    const scoped = events.filter((e) => e.scope && e.type.startsWith('h:'));
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((e) => e.data.agentId === undefined)).toBe(true);
  });

  it('two turns that reuse a child session id are two nested agents', () => {
    const first = bridge();
    first.bridge.begin();
    first.bridge.forwardChild(announce('c1'));
    const second = bridge();
    second.bridge.begin();
    second.bridge.forwardChild(announce('c1'));
    expect(first.events.find((e) => e.scope)?.scope?.id).not.toBe(
      second.events.find((e) => e.scope)?.scope?.id,
    );
  });

  it("reports a nested agent's own tool calls with the generic tool events", () => {
    const { bridge: b, events } = bridge();
    b.begin();
    b.forwardChild(announce('c1'));
    b.forwardChild(
      own('c1', {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read',
      }),
    );
    b.forwardChild(
      own('c1', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
      }),
    );
    const tools = events.filter((e) => /:tool_call_(started|completed)$/.test(e.type));
    expect(
      tools.map((e) => [
        e.type.split(':')[1],
        e.data.name,
        e.data.error,
      ]),
    ).toEqual([
      [
        'tool_call_started',
        'Read',
        undefined,
      ],
      [
        'tool_call_completed',
        'Read',
        false,
      ],
    ]);
    expect(tools.every((e) => e.scope !== undefined)).toBe(true);
  });

  it("reports a subagent's file and terminal calls as its own", () => {
    const { bridge: b, events } = bridge();
    b.begin();
    b.forwardChild(announce('c1'));
    b.forwardActivity({
      method: 'fs/read_text_file',
      path: '/w/a.ts',
      allowed: true,
      sessionId: 'c1',
    });
    b.forwardActivity({
      method: 'fs/read_text_file',
      path: '/w/b.ts',
      allowed: true,
      sessionId: 'root',
    });
    const activity = events.filter((e) => e.type.endsWith(':acp_client_activity'));
    expect(
      activity.map((e) => [
        e.data.path,
        e.scope !== undefined,
      ]),
    ).toEqual([
      [
        '/w/a.ts',
        true,
      ],
      [
        '/w/b.ts',
        false,
      ],
    ]);
  });
});

describe("a subagent's bridged tool call", () => {
  it("is its nested agent's: scoped events, and never in the step's items", async () => {
    const harness = new AgentHarness({
      name: 'h',
      params: {},
    });
    const ctx = harness.createContext();
    const events: Captured[] = [];
    frameworkCast<{
      _broadcaster: unknown;
    }>(ctx)._broadcaster = {
      emit(event: Captured) {
        events.push(event);
      },
    };
    const echo = tool({
      name: 'echo',
      description: 'Echo the text.',
      input: z.object({
        text: z.string(),
      }),
      output: z.string(),
      execute: async ({ text }) => text,
    });
    const agent: AcpAgent = {
      specificationVersion: 'acp-v1',
      agentId: 'fake',
      async connect(connect): Promise<AcpAgentConnection> {
        const session: AcpSession = {
          sessionId: 'root',
          availableCommands: [],
          async prompt(): Promise<AcpTurnResult> {
            const tools = connect.host.tools;
            if (!tools) {
              throw new Error('no tools served');
            }
            connect.host.onChildUpdate?.(announce('c1'));
            connect.host.onChildUpdate?.(
              own('c1', {
                sessionUpdate: 'tool_call',
                toolCallId: 'child-call',
                title: 'mcp__noetic__echo',
              }),
            );
            await tools.call({
              name: 'echo',
              args: {
                text: 'from the child',
              },
              agentCallId: 'child-call',
              signal: new AbortController().signal,
            });
            return {
              stopReason: 'end_turn',
              items: [
                makeMessage('assistant', 'done'),
              ],
              text: 'done',
            };
          },
          async cancel() {},
          async setMode() {},
          async setModel() {},
        };
        return {
          agentCapabilities: {},
          authMethods: [],
          protocolVersion: 1,
          fingerprintFor: (): string => 'fake',
          async authenticate() {},
          async newSession() {
            return session;
          },
          async loadSession() {
            return session;
          },
          async close() {},
        };
      },
    };
    await execute(
      step.acpAgent({
        id: 'parent',
        agent,
        prompt: 'go',
        tools: [
          echo,
        ],
      }),
      undefined,
      ctx,
    );
    expect(JSON.stringify(ctx.itemLog.items)).not.toContain('from the child');
    const appended = events.filter((e) => e.type.endsWith(':item_appended'));
    expect(appended.length).toBeGreaterThan(0);
    expect(appended.every((e) => e.scope !== undefined)).toBe(true);
  });
});
