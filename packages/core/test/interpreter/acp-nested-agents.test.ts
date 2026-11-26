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
import { heldCallsOf, heldScopeOf } from '../../src/runtime/held-calls';
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
      ctx,
    ),
  };
}

function announce(child: string, state?: Record<string, unknown>): AcpChildUpdate {
  return {
    sessionId: child,
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

  it("a subagent's call reported already finished completes once", () => {
    const { bridge: b, events } = bridge();
    b.begin();
    b.forwardChild(announce('c1'));
    b.forwardChild(
      own('c1', {
        sessionUpdate: 'tool_call',
        toolCallId: 't2',
        title: 'Grep',
        status: 'failed',
      }),
    );
    b.forwardChild(
      own('c1', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't2',
        status: 'failed',
      }),
    );
    const tools = events.filter((e) => /:tool_call_(started|completed)$/.test(e.type));
    expect(
      tools.map((e) => [
        e.type.split(':')[1],
        e.data.error,
      ]),
    ).toEqual([
      [
        'tool_call_started',
        undefined,
      ],
      [
        'tool_call_completed',
        true,
      ],
    ]);
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
    const activity = events.filter((e) => e.type.endsWith(':workspace_access'));
    expect(activity[0]?.data).toMatchObject({
      operation: 'read_file',
      path: '/w/a.ts',
      allowed: true,
    });
    expect(activity[0]?.data).not.toHaveProperty('method');
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
  announce: 'before' | 'during' | 'after' | 'never';
  /** Whether a subagent speaks at all this turn. Default true. */
  subagent?: boolean;
  /** The tool needs approval, which the harness's `onHeld` gives. */
  approval?: boolean;
  /** The agent's prompt fails after the call finished. */
  failAfter?: boolean;
  /** The agent gives up on the call while its owner is still being settled. */
  abortDuringWait?: boolean;
  /** An approver that takes a while, then leaves the call to a person. */
  slowApprover?: boolean;
  /** After the first call, the step announces and makes a call of its own. */
  stepCallAfter?: boolean;
  /** The person takes a while to approve; who the hold names is read meanwhile. */
  slowPerson?: boolean;
  /** While the call runs, the step's own agent announces it too. */
  stepAnnouncesDuring?: boolean;
}

async function runChildCall(opts: ChildCallOptions): Promise<{
  items: string;
  events: Captured[];
  held: HeldCall[];
  runs: number;
  /** Who the open hold named while the slow person decided. */
  askers: (string | undefined)[];
}> {
  let runs = 0;
  {
    const held: HeldCall[] = [];
    const askers: (string | undefined)[] = [];
    const harness = new AgentHarness({
      name: 'h',
      params: {},
      onHeld: async (call) => {
        held.push(call);
        if (opts.slowPerson) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          const records = await heldCallsOf(harness).list(heldScopeOf(ctx));
          askers.push(...records.map((record) => record.scope?.title));
        }
        return {
          action: 'allow',
        };
      },
      ...(opts.slowApprover
        ? {
            approveToolCall: async () => {
              await new Promise((resolve) => setTimeout(resolve, 30));
              return {
                action: 'hold' as const,
              };
            },
          }
        : {}),
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
      execute: async ({ text }) => {
        runs += 1;
        // Long enough for an announcement sent mid-call to land while it runs.
        if (opts.announce === 'during' || opts.stepAnnouncesDuring) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return text;
      },
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
            const giveUp = new AbortController();
            const calling = tools.call({
              name: 'echo',
              args: {
                text: 'from the child',
              },
              agentCallId: 'child-call',
              signal: giveUp.signal,
            });
            if (opts.abortDuringWait) {
              giveUp.abort();
            }
            if (opts.announce === 'during') {
              await new Promise((resolve) => setTimeout(resolve, 5));
              announceCall();
            }
            if (opts.stepAnnouncesDuring) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              connect.host.onSessionUpdate?.({
                sessionId: 'root',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'child-call',
                  title: 'mcp__noetic__echo',
                },
              });
            }
            await calling;
            if (opts.announce === 'after') {
              announceCall();
            }
            if (opts.stepCallAfter) {
              connect.host.onSessionUpdate?.({
                sessionId: 'root',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'step-call',
                  title: 'mcp__noetic__echo',
                },
              });
              await tools.call({
                name: 'echo',
                args: {
                  text: 'from the step',
                },
                agentCallId: 'step-call',
                signal: new AbortController().signal,
              });
            }
            if (opts.failAfter) {
              throw new Error('the agent fell over');
            }
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
    ).catch((error: unknown) => {
      if (!opts.failAfter) {
        throw error;
      }
    });
    return {
      items: JSON.stringify(ctx.itemLog.items),
      events,
      held,
      runs,
      askers,
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

  it('a call made before any subagent update, then announced by one, is the subagent’s', async () => {
    const { items, events } = await runChildCall({
      announce: 'during',
      subagent: false,
    });
    expect(items).not.toContain('from the child');
    const appended = events.filter(
      (e) => e.type.endsWith(':item_appended') && JSON.stringify(e.data).includes('from the child'),
    );
    expect(appended.map((e) => e.scope?.title)).toEqual([
      'Explore',
    ]);
  });

  it('a call announced by a subagent while its approver decides is held naming that subagent', async () => {
    const { held } = await runChildCall({
      announce: 'during',
      subagent: false,
      approval: true,
      slowApprover: true,
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
  });

  it("a step's call after an unsettled one waits behind it: results keep the order they finished", async () => {
    const { items, events } = await runChildCall({
      announce: 'never',
      stepCallAfter: true,
    });
    expect(items.indexOf('from the child')).toBeLessThan(items.indexOf('from the step'));
    const order = events
      .filter((e) => e.type.endsWith(':item_appended') && !e.scope)
      .map((e) => JSON.stringify(e.data))
      .filter((data) => data.includes('from the'))
      .map((data) => (data.includes('from the child') ? 'child' : 'step'));
    expect(order).toEqual([
      'child',
      'step',
    ]);
  }, 10e3);

  it('a held call a subagent first speaks to announce is renamed to it while the person decides', async () => {
    // The announcement is the turn's first word from the subagent: its
    // lineage is learnt from that same update.
    const { askers } = await runChildCall({
      announce: 'during',
      subagent: false,
      approval: true,
      slowPerson: true,
    });
    expect(askers).toEqual([
      'Explore',
    ]);
  });

  it("a call the step's own agent announces while it runs is the step's, whoever announced it first", async () => {
    const { items, events } = await runChildCall({
      announce: 'before',
      stepAnnouncesDuring: true,
    });
    expect(items).toContain('from the child');
    const appended = events.filter(
      (e) => e.type.endsWith(':item_appended') && JSON.stringify(e.data).includes('from the child'),
    );
    expect(appended.map((e) => e.scope)).toEqual([
      undefined,
    ]);
  });

  it('a failed turn still publishes what its finished calls returned', async () => {
    const { events } = await runChildCall({
      announce: 'never',
      subagent: false,
      failAfter: true,
    });
    const appended = events.filter(
      (e) => e.type.endsWith(':item_appended') && JSON.stringify(e.data).includes('from the child'),
    );
    expect(appended.length).toBe(1);
    const published = events.findIndex(
      (e) => e.type.endsWith(':item_appended') && JSON.stringify(e.data).includes('from the child'),
    );
    const completed = events.findIndex((e) => e.type === 'response.completed' && !e.scope);
    expect(published).toBeLessThan(completed);
  });

  it('a call given up on while its owner is being settled never runs', async () => {
    const { runs } = await runChildCall({
      announce: 'never',
      abortDuringWait: true,
    });
    expect(runs).toBe(0);
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

  it("a call nobody announced while subagents are about is the step's: never dropped", async () => {
    const { items, events } = await runChildCall({
      announce: 'never',
    });
    expect(items).toContain('from the child');
    const appended = events.filter(
      (e) => e.type.endsWith(':item_appended') && JSON.stringify(e.data).includes('from the child'),
    );
    expect(appended.length).toBe(1);
    expect(appended[0]?.scope).toBeUndefined();
  }, 10e3);

  it('a call a subagent announces only after it ran is still its own, settled at the turn’s end', async () => {
    const { items, events } = await runChildCall({
      announce: 'after',
    });
    expect(items).not.toContain('from the child');
    const appended = events.filter(
      (e) => e.type.endsWith(':item_appended') && JSON.stringify(e.data).includes('from the child'),
    );
    expect(appended.length).toBe(1);
    expect(appended[0]?.scope?.title).toBe('Explore');
    // Its item and its whole lifecycle are the subagent's too, never the step's.
    const call = events.filter(
      (e) =>
        (/tool_call_(started|completed)$/.test(e.type) && e.data.callId === 'child-call') ||
        (e.type === 'response.output_item.done' && JSON.stringify(e.data).includes('child-call')),
    );
    expect(
      call.map((e) => [
        e.type.replace(/^.*:/, ''),
        e.scope?.title,
      ]),
    ).toEqual([
      [
        'response.output_item.done',
        'Explore',
      ],
      [
        'tool_call_started',
        'Explore',
      ],
      [
        'tool_call_completed',
        'Explore',
      ],
    ]);
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

describe('a nested agent: what started it, what it was asked, and stopping it', () => {
  function started(): {
    harness: AgentHarness;
    events: Captured[];
    bridge: AcpEventBridge;
    stopped: string[];
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
    const b = new AcpEventBridge(
      {
        id: 'step',
      },
      ctx,
    );
    const stopped: string[] = [];
    b.offerChildStops(async (sessionId) => {
      stopped.push(sessionId);
    });
    return {
      harness,
      events,
      bridge: b,
      stopped,
    };
  }

  const lineage = (cancellable: boolean) => [
    {
      sessionId: 'kid',
      title: 'general-purpose',
      description: 'Count files',
      cancellable,
    },
  ];

  /** The parent's Agent call, then the child's first message naming it. */
  function launch(b: AcpEventBridge, cancellable: boolean): void {
    b.begin();
    b.forward({
      sessionId: 'root',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_agent',
        title: 'Agent',
        status: 'pending',
        rawInput: {},
      },
    });
    b.forwardChild({
      sessionId: 'kid',
      announcement: true,
      lineage: lineage(cancellable),
      update: {
        sessionUpdate: 'subagent_update',
        sessionId: 'kid',
        title: 'general-purpose',
        description: 'Count files',
        state: {
          state: 'running',
        },
      },
    });
    b.forwardChild({
      sessionId: 'kid',
      announcement: false,
      lineage: lineage(cancellable),
      update: {
        sessionUpdate: 'session_message',
        messageId: 'toolu_agent',
        senderSessionId: 'root',
        recipientSessionId: 'kid',
        content: [
          {
            type: 'text',
            text: 'Run ls and wc -l.',
          },
        ],
      },
    });
  }

  it('names the call that started it and shows its prompt as its input', () => {
    const { events, bridge: b } = started();
    launch(b, true);
    const start = events.find((e) => e.type === 'h:agent_started');
    expect(start?.data).toEqual({
      stepId: 'step',
      title: 'general-purpose',
      description: 'Count files',
      callId: 'toolu_agent',
      cancellable: true,
    });
    const input = events.find((e) => e.type === 'h:item_appended' && e.scope);
    expect(input?.scope).toEqual(start?.scope);
    expect(input?.data.item).toMatchObject({
      type: 'message',
      role: 'user',
    });
    expect(JSON.stringify(input?.data.item)).toContain('Run ls and wc -l.');
  });

  it('stops one cancellable nested agent through the harness, while its turn runs', async () => {
    const { harness, events, bridge: b, stopped } = started();
    launch(b, true);
    const scope = events.find((e) => e.type === 'h:agent_started')?.scope;
    if (!scope) {
      throw new Error('no nested agent');
    }
    expect(await harness.stopAgent(scope.id)).toBe(true);
    expect(stopped).toEqual([
      'kid',
    ]);
    expect(await harness.stopAgent('no-such-agent')).toBe(false);
    b.finalize(RESULT);
    // Its turn is over: nothing is left to stop.
    expect(await harness.stopAgent(scope.id)).toBe(false);
  });

  it('offers no stop for an agent its agent does not let a client stop', async () => {
    const { harness, events, bridge: b, stopped } = started();
    launch(b, false);
    const start = events.find((e) => e.type === 'h:agent_started');
    expect(start?.data.cancellable).toBe(false);
    expect(await harness.stopAgent(start?.scope?.id ?? '')).toBe(false);
    expect(stopped).toEqual([]);
  });
});

describe('stopping a nested agent through a running step', () => {
  const kid = (update: AcpChildUpdate['update'], announcement = false): AcpChildUpdate => ({
    sessionId: 'kid',
    announcement,
    lineage: [
      {
        sessionId: 'kid',
        title: 'general-purpose',
        cancellable: true,
      },
    ],
    update,
  });

  /** One step whose agent starts a cancellable subagent; the host stops it mid-turn. */
  async function runOnce(opts: { fail?: boolean; emit?: false }): Promise<{
    events: Captured[];
    cancelled: string[];
    duringTurn: boolean;
    afterTurn: boolean;
  }> {
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
    const cancelled: string[] = [];
    let duringTurn = false;
    const agent: AcpAgent = {
      specificationVersion: 'acp-v1',
      agentId: 'fake',
      async connect(connect): Promise<AcpAgentConnection> {
        const session: AcpSession = {
          sessionId: 'root',
          availableCommands: [],
          async prompt(): Promise<AcpTurnResult> {
            connect.host.onChildUpdate?.(
              kid(
                {
                  sessionUpdate: 'subagent_update',
                  sessionId: 'kid',
                  state: {
                    state: 'running',
                  },
                },
                true,
              ),
            );
            connect.host.onChildUpdate?.(kid(work('kid').update));
            const scope = events.find((e) => e.type === 'h:agent_started')?.scope;
            duringTurn = await harness.stopAgent(scope?.id ?? 'unknown');
            if (opts.fail) {
              throw new Error('the agent fell over');
            }
            return RESULT;
          },
          async cancel() {},
          async cancelChild(sessionId) {
            cancelled.push(sessionId);
          },
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
        ...(opts.emit === false
          ? {
              emit: false,
            }
          : {}),
      }),
      undefined,
      ctx,
    ).catch(() => undefined);
    const scope = events.find((e) => e.type === 'h:agent_started')?.scope;
    return {
      events,
      cancelled,
      duringTurn,
      afterTurn: await harness.stopAgent(scope?.id ?? 'unknown'),
    };
  }

  it('stops it through the session while the turn runs, and offers nothing once it ended', async () => {
    const run = await runOnce({});
    expect(run.duringTurn).toBe(true);
    expect(run.cancelled).toEqual([
      'kid',
    ]);
    expect(run.afterTurn).toBe(false);
  });

  it('takes the offer back when the turn fails', async () => {
    const run = await runOnce({
      fail: true,
    });
    expect(run.duringTurn).toBe(true);
    expect(run.afterTurn).toBe(false);
  });
});

describe('a nested agent, the step emitting nothing', () => {
  it('emits nothing of it, not even what it was asked', () => {
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
    const b = new AcpEventBridge(
      {
        id: 'step',
        emit: false,
      },
      ctx,
    );
    b.begin();
    b.forwardChild(announce('kid'));
    b.forwardChild(
      own('kid', {
        sessionUpdate: 'session_message',
        messageId: 'm1',
        senderSessionId: 'root',
        recipientSessionId: 'kid',
        content: [
          {
            type: 'text',
            text: 'Do it.',
          },
        ],
      }),
    );
    expect(events.filter((e) => e.scope && e.type.startsWith('h:'))).toEqual([]);
  });

  it('a stopped one offers no second stop', async () => {
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
    const b = new AcpEventBridge(
      {
        id: 'step',
      },
      ctx,
    );
    const stopped: string[] = [];
    b.offerChildStops(async (sessionId) => {
      stopped.push(sessionId);
    });
    b.begin();
    const lineage = [
      {
        sessionId: 'kid',
        title: 'Explore',
        cancellable: true,
      },
    ];
    b.forwardChild({
      ...work('kid'),
      lineage,
    });
    b.forwardChild({
      sessionId: 'kid',
      announcement: true,
      lineage,
      update: {
        sessionUpdate: 'subagent_update',
        sessionId: 'kid',
        state: frameworkCast<{
          state: 'running';
        }>({
          state: 'idle',
          stopReason: 'end_turn',
        }),
      },
    });
    const scope = events.find((e) => e.type === 'h:agent_started')?.scope;
    expect(await harness.stopAgent(scope?.id ?? '')).toBe(false);
    expect(stopped).toEqual([]);
  });
});
