/**
 * An agent step's subagents as nested agents (spec 08 § Nested agents,
 * spec 27 § Subagents): the event bridge's side.
 */

import { describe, expect, it } from 'bun:test';
import type {
  AcpAgent,
  AcpAgentConnection,
  AcpChildUpdate,
  AcpClientHost,
  AcpSession,
  AcpTurnResult,
  AgentScope,
  HeldCall,
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
    lineage: [
      {
        sessionId: child,
        title: 'Explore',
      },
    ],
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
    lineage: [
      {
        sessionId: child,
        title: 'Explore',
      },
    ],
    update,
  };
}

/** Something the child does this turn: what shows a nested agent. */
function work(child: string): AcpChildUpdate {
  return own(child, {
    sessionUpdate: 'agent_thought_chunk',
    content: {
      type: 'text',
      text: 'thinking',
    },
  });
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
  it('an announcement alone shows nothing: a child that does no work this turn is not a nested agent', () => {
    const { bridge: b, events } = bridge();
    b.begin();
    b.forwardChild(announce('idle-child'));
    b.finalize(RESULT);
    expect(events.filter((e) => e.scope)).toEqual([]);
  });

  it('a grandchild that speaks first opens under its whole parent chain', () => {
    const { bridge: b, events } = bridge();
    b.begin();
    b.forwardChild({
      sessionId: 'grand',
      parentSessionId: 'kid',
      announcement: false,
      lineage: [
        {
          sessionId: 'kid',
          title: 'Plan',
        },
        {
          sessionId: 'grand',
          title: 'Search',
        },
      ],
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'found it',
        },
      },
    });
    const started = events.filter((e) => e.type.endsWith(':agent_started'));
    const [kid, grand] = started.map((e) => e.scope);
    expect(started.map((e) => e.data.title)).toEqual([
      'Plan',
      'Search',
    ]);
    expect(kid?.parentId).toBeUndefined();
    expect(grand?.parentId).toBe(kid?.id);
  });

  it('a request from a child is resolved to its nested agent', () => {
    const { bridge: b } = bridge();
    b.begin();
    b.forwardChild(announce('c1'));
    const scope = b.scopeFor('c1');
    expect(scope?.title).toBe('Explore');
    expect(b.scopeFor('root')).toBeUndefined();
    expect(b.scopeFor(undefined)).toBeUndefined();
  });

  it('opens nothing for an update that arrives after the turn ended', () => {
    const { bridge: b, events } = bridge();
    b.begin();
    b.forwardChild(announce('c1'));
    b.forwardChild(work('c1'));
    b.finalize(RESULT);
    b.forwardChild(announce('c2'));
    b.forwardChild(work('c2'));
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
    b.forwardChild(work('c1'));
    b.finalize(RESULT);
    expect(lifecycle(events).at(-1)).toBe('agent_completed:completed');
  });

  it("names a nested agent by its scope alone, never the adapter's id", () => {
    const { bridge: b, events } = bridge();
    b.begin();
    b.forwardChild(announce('c1'));
    b.forwardChild(work('c1'));
    const scoped = events.filter((e) => e.scope && e.type.startsWith('h:'));
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((e) => e.data.agentId === undefined)).toBe(true);
  });

  it('two turns that reuse a child session id are two nested agents', () => {
    const first = bridge();
    first.bridge.begin();
    first.bridge.forwardChild(announce('c1'));
    first.bridge.forwardChild(work('c1'));
    const second = bridge();
    second.bridge.begin();
    second.bridge.forwardChild(announce('c1'));
    second.bridge.forwardChild(work('c1'));
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

interface ChildCallOptions {
  /** When the subagent's `tool_call` arrives: before the MCP call, during it, or never. */
  announce: 'before' | 'during' | 'never';
  /** Whether a subagent speaks at all this turn. Default true. */
  subagent?: boolean;
  /** The tool needs approval, which the harness's `onHeld` gives. */
  approval?: boolean;
}

async function runChildCall(opts: ChildCallOptions): Promise<{
  items: string;
  events: Captured[];
  held: HeldCall[];
}> {
  {
    const held: HeldCall[] = [];
    const harness = new AgentHarness({
      name: 'h',
      params: {},
      onHeld: (call) => {
        held.push(call);
        return {
          action: 'allow',
        };
      },
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
      needsApproval: opts.approval === true,
      execute: async ({ text }) => text,
    });
    const announceCall = (): void => {
      connectHost?.onChildUpdate?.(
        own('c1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'child-call',
          title: 'mcp__noetic__echo',
        }),
      );
    };
    let connectHost: AcpClientHost | undefined;
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
            connectHost = connect.host;
            if (opts.subagent !== false) {
              connect.host.onChildUpdate?.(announce('c1'));
              connect.host.onChildUpdate?.(work('c1'));
            }
            if (opts.announce === 'before') {
              announceCall();
            }
            const calling = tools.call({
              name: 'echo',
              args: {
                text: 'from the child',
              },
              agentCallId: 'child-call',
              signal: new AbortController().signal,
            });
            if (opts.announce === 'during') {
              await new Promise((resolve) => setTimeout(resolve, 5));
              announceCall();
            }
            await calling;
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
    return {
      items: JSON.stringify(ctx.itemLog.items),
      events,
      held,
    };
  }
}

describe("a subagent's bridged tool call", () => {
  it("is its nested agent's: scoped events, one lifecycle, never in the step's items", async () => {
    const { items, events } = await runChildCall({
      announce: 'before',
    });
    expect(items).not.toContain('from the child');
    const appended = events.filter((e) => e.type.endsWith(':item_appended'));
    expect(appended.length).toBeGreaterThan(0);
    expect(appended.every((e) => e.scope !== undefined)).toBe(true);
    const lifecycle = events.filter(
      (e) => /:tool_call_(started|completed)$/.test(e.type) && e.data.callId === 'child-call',
    );
    expect(lifecycle.map((e) => e.type.split(':')[1])).toEqual([
      'tool_call_started',
      'tool_call_completed',
    ]);
  });

  it('a subagent call announced while it is already running is still its own', async () => {
    const { items, events } = await runChildCall({
      announce: 'during',
    });
    expect(items).not.toContain('from the child');
    const appended = events.filter((e) => e.type.endsWith(':item_appended'));
    expect(appended.length).toBeGreaterThan(0);
    expect(appended.every((e) => e.scope !== undefined)).toBe(true);
  });

  it('with no subagent this turn, an unannounced call is the step’s, at once', async () => {
    const started = Date.now();
    const { items } = await runChildCall({
      announce: 'never',
      subagent: false,
    });
    expect(items).toContain('from the child');
    expect(Date.now() - started).toBeLessThan(1e3);
  });

  it("a subagent's call that needs approval is held as the run's, naming the subagent", async () => {
    const { held, events } = await runChildCall({
      announce: 'before',
      approval: true,
    });
    expect(
      held.map((call) => [
        call.reason,
        call.scope?.title,
      ]),
    ).toEqual([
      [
        'approval',
        'Explore',
      ],
    ]);
    const heldEvents = events.filter((e) => e.type.endsWith(':tool_call_held'));
    expect(heldEvents.length).toBe(1);
    expect(heldEvents[0]?.scope).toBeUndefined();
  });

  it('a call nobody announced while subagents are about joins neither the items nor the item stream', async () => {
    const { items, events } = await runChildCall({
      announce: 'never',
    });
    expect(items).not.toContain('from the child');
    const appended = events.filter((e) => e.type.endsWith(':item_appended'));
    expect(JSON.stringify(appended)).not.toContain('from the child');
  }, 10e3);
});

describe("a subagent's requests to a person", () => {
  it('are held as the run’s, named as its nested agent’s', async () => {
    const held: HeldCall[] = [];
    const harness = new AgentHarness({
      name: 'h',
      params: {},
      onHeld: (call) => {
        held.push(call);
        return call.reason === 'question'
          ? {
              action: 'deny',
            }
          : {
              action: 'allow',
            };
      },
    });
    const ctx = harness.createContext();
    const heldEvents: Captured[] = [];
    frameworkCast<{
      _broadcaster: unknown;
    }>(ctx)._broadcaster = {
      emit(event: Captured) {
        if (event.type.endsWith(':tool_call_held')) {
          heldEvents.push(event);
        }
      },
    };
    const agent: AcpAgent = {
      specificationVersion: 'acp-v1',
      agentId: 'fake',
      async connect(connect): Promise<AcpAgentConnection> {
        const session: AcpSession = {
          sessionId: 'root',
          availableCommands: [],
          async prompt(): Promise<AcpTurnResult> {
            connect.host.onChildUpdate?.(announce('c1'));
            await connect.host.approvePermission?.({
              sessionId: 'c1',
              toolCall: {
                toolCallId: 'bash-1',
                title: 'Bash',
              },
              options: [
                {
                  optionId: 'ok',
                  kind: 'allow_once',
                  name: 'Allow',
                },
              ],
            });
            await connect.host.onElicitation?.(
              {
                mode: 'form',
                sessionId: 'c1',
                message: 'Which?',
                requestedSchema: {
                  type: 'object',
                  properties: {},
                },
              },
              {},
            );
            return {
              stopReason: 'end_turn',
              items: [],
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
      }),
      undefined,
      ctx,
    );
    expect(
      held.map((call) => [
        call.reason,
        call.scope?.title,
      ]),
    ).toEqual([
      [
        'approval',
        'Explore',
      ],
      [
        'question',
        'Explore',
      ],
    ]);
    // The held events themselves are the run's: every host that answers sees them.
    expect(heldEvents.length).toBe(2);
    expect(heldEvents.every((e) => e.scope === undefined)).toBe(true);
  });
});
