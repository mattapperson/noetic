/**
 * The server direction, driven by Noetic's own ACP client over loopback —
 * both directions of the codebase exercising each other on the real wire
 * protocol, no process spawned.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpAgentConnection,
  AcpPermissionPolicy,
  AcpSessionNotification,
  ContextLayer,
  ExecuteInput,
  ExecuteOptions,
  ExecutionContext,
  Item,
  StreamEvent,
  StreamingItem,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { openAcpConnection } from '../src/connection';
import { toAcpAgent } from '../src/serve';
import { evaluateServePolicy, ServePermissionBroker } from '../src/serve-permissions';
import type { AcpServeHarness, AcpServeOptions } from '../src/serve-types';
import { loopbackTransport } from '../src/transport-loopback';
import { MemoryFs, RecordingShell } from './_helpers';

//#region Serve-side mock harness

function sdkEvent(type: string, data: Record<string, unknown>): StreamEvent {
  return {
    source: 'sdk',
    type,
    data,
  };
}

function fwEvent(name: string, data: Record<string, unknown>): StreamEvent {
  return {
    source: 'framework',
    type: `serve-agent:${name}`,
    data,
  };
}

interface ScriptedToolCall {
  name: string;
  callId: string;
  args?: Record<string, unknown>;
}

interface ServeMockScript {
  /** Extra events emitted inside the turn, before the tool calls. */
  body?: StreamEvent[];
  /** Tool calls simulated through the injected gate layer (started → gate → completed). */
  tools?: ScriptedToolCall[];
  /** Items served by `getItemStream` (already flagged with `isComplete`). */
  items?: StreamingItem[];
  /** Keep the item stream open after draining `items` (real-broadcaster behavior). */
  holdItemStream?: boolean;
  /** Set false to leave the turn open (cancellation tests drive it manually). */
  completeTurn?: boolean;
}

interface ServeMockHarness extends AcpServeHarness {
  readonly executed: Array<{
    input: ExecuteInput;
    options: ExecuteOptions | undefined;
  }>;
  readonly seeded: Array<{
    threadId: string;
    items: ReadonlyArray<Item>;
  }>;
  readonly aborts: Array<string | undefined>;
  /** Every decision the injected gate layer returned, in order. */
  readonly gateDecisions: Array<{
    action: string;
    guidance?: string;
  }>;
  /** Whether the item-stream consumer was released via iterator.return(). */
  itemStreamClosed(): boolean;
  /** Currently-attached full-stream consumers (0 after each turn = no leak). */
  liveEventConsumers(): number;
  /** Resolves when the current turn's async continuation has finished emitting. */
  turnDone(): Promise<void>;
}

/**
 * Emulates the session pipeline's sharp edges the way chat-sdk's mock does —
 * `turn_started` emitted synchronously inside execute(), broadcaster replay +
 * discard rules — and additionally runs the injected gate layer for scripted
 * tool calls, with `tool_call_started` emitted BEFORE the gate is awaited
 * (the spec-31 ordering the real interpreter guarantees).
 */
function serveMockHarness(script: ServeMockScript): ServeMockHarness {
  const executed: ServeMockHarness['executed'] = [];
  const seeded: ServeMockHarness['seeded'] = [];
  const aborts: ServeMockHarness['aborts'] = [];
  const gateDecisions: ServeMockHarness['gateDecisions'] = [];

  const buffer: StreamEvent[] = [];
  const wakeups: Array<() => void> = [];
  let everAttached = false;
  let liveConsumers = 0;
  let turnCounter = 0;
  let currentTurnId: string | null = null;
  let aborted = false;
  let turnSettled: Promise<void> = Promise.resolve();
  let itemStreamClosed = false;
  const itemWakeups: Array<() => void> = [];

  const emit = (event: StreamEvent): void => {
    if (everAttached && liveConsumers === 0) {
      return;
    }
    buffer.push(event);
    for (const wake of wakeups.splice(0)) {
      wake();
    }
  };

  function consume(): AsyncIterator<StreamEvent> {
    everAttached = true;
    liveConsumers++;
    let cursor = 0;
    let finished = false;
    const finish = (): void => {
      if (!finished) {
        finished = true;
        liveConsumers--;
      }
    };
    return {
      async next(): Promise<IteratorResult<StreamEvent>> {
        while (!finished) {
          if (cursor < buffer.length) {
            return {
              value: buffer[cursor++],
              done: false,
            };
          }
          await new Promise<void>((resolve) => {
            wakeups.push(resolve);
          });
        }
        return {
          value: undefined,
          done: true,
        };
      },
      return(): Promise<IteratorResult<StreamEvent>> {
        finish();
        return Promise.resolve({
          value: undefined,
          done: true,
        });
      },
    };
  }

  async function runGatedTool(tool: ScriptedToolCall, layers: ContextLayer[]): Promise<void> {
    emit(
      sdkEvent('response.output_item.done', {
        item: {
          type: 'function_call',
          callId: tool.callId,
          name: tool.name,
          arguments: JSON.stringify(tool.args ?? {}),
        },
      }),
    );
    emit(
      fwEvent('tool_call_started', {
        name: tool.name,
        callId: tool.callId,
      }),
    );
    let allowed = true;
    for (const layer of layers) {
      if (!layer.hooks.beforeToolCall) {
        continue;
      }
      const result = await layer.hooks.beforeToolCall({
        toolName: tool.name,
        toolArgs: tool.args ?? {},
        callId: tool.callId,
        ctx: frameworkCast<ExecutionContext>({
          executionId: 'exec-1',
          threadId: 'thread-1',
        }),
        state: undefined,
      });
      gateDecisions.push(result.decision);
      if (result.decision.action !== 'allow') {
        allowed = false;
        break;
      }
    }
    emit(
      fwEvent('tool_call_completed', {
        name: tool.name,
        callId: tool.callId,
        error: !allowed,
      }),
    );
  }

  async function runTurnBody(turnId: string, layers: ContextLayer[]): Promise<void> {
    for (const event of script.body ?? []) {
      emit(event);
    }
    for (const tool of script.tools ?? []) {
      if (aborted) {
        return;
      }
      await runGatedTool(tool, layers);
    }
    if (script.completeTurn !== false && !aborted) {
      emit(
        fwEvent('turn_completed', {
          turnId,
          durationMs: 1,
        }),
      );
    }
  }

  return {
    executed,
    seeded,
    aborts,
    gateDecisions,
    turnDone: () => turnSettled,
    execute(input, options) {
      executed.push({
        input,
        options,
      });
      const turnId = `turn-${++turnCounter}`;
      currentTurnId = turnId;
      aborted = false;
      emit(
        fwEvent('turn_started', {
          turnId,
          messageIds: [
            options?.messageId ?? 'unknown',
          ],
        }),
      );
      turnSettled = runTurnBody(turnId, options?.extraContextLayers ?? []);
      return Promise.resolve();
    },
    itemStreamClosed: () => itemStreamClosed,
    liveEventConsumers: () => liveConsumers,
    getItemStream() {
      return {
        [Symbol.asyncIterator]: () => {
          let cursor = 0;
          let released = false;
          const items = script.items ?? [];
          return {
            async next(): Promise<IteratorResult<StreamingItem>> {
              if (released) {
                return {
                  value: undefined,
                  done: true,
                };
              }
              if (cursor < items.length) {
                const value = items[cursor++];
                if (value === undefined) {
                  return {
                    value: undefined,
                    done: true,
                  };
                }
                return {
                  value,
                  done: false,
                };
              }
              if (script.holdItemStream) {
                await new Promise<void>((resolve) => {
                  itemWakeups.push(resolve);
                });
              }
              return {
                value: undefined,
                done: true,
              };
            },
            async return(): Promise<IteratorResult<StreamingItem>> {
              released = true;
              itemStreamClosed = true;
              for (const wake of itemWakeups.splice(0)) {
                wake();
              }
              return {
                value: undefined,
                done: true,
              };
            },
          };
        },
      };
    },
    getFullStream() {
      return {
        [Symbol.asyncIterator]: () => consume(),
      };
    },
    seedSessionHistory(threadId, items) {
      seeded.push({
        threadId,
        items,
      });
    },
    abort(scope) {
      aborts.push(scope?.reason);
      if (currentTurnId !== null && !aborted) {
        aborted = true;
        emit(
          fwEvent('turn_aborted', {
            turnId: currentTurnId,
            reason: scope?.reason ?? 'aborted',
          }),
        );
      }
      return Promise.resolve();
    },
  };
}

//#endregion

//#region Rig

interface ServeRig {
  mock: ServeMockHarness;
  connection: AcpAgentConnection;
  updates: AcpSessionNotification[];
  /** The client-side host, mutable per-turn (permissions, handlers). */
  host: Record<string, unknown>;
  close(): Promise<void>;
}

async function createServeRig(opts: {
  script: ServeMockScript;
  serve?: AcpServeOptions;
  clientPermissions?: AcpPermissionPolicy;
}): Promise<ServeRig> {
  const mock = serveMockHarness(opts.script);
  const transport = await loopbackTransport(toAcpAgent(mock, opts.serve))({
    cwd: '/workspace',
  });
  const updates: AcpSessionNotification[] = [];
  const host = {
    cwd: '/workspace',
    fs: new MemoryFs(),
    shell: new RecordingShell(),
    threadId: 'client-thread',
    permissions: opts.clientPermissions,
    onSessionUpdate: (notification: AcpSessionNotification) => {
      updates.push(notification);
    },
  };
  const connection = await openAcpConnection({
    agentId: 'noetic-serve',
    transport,
    host,
  });
  return {
    mock,
    connection,
    updates,
    host: frameworkCast<Record<string, unknown>>(host),
    close: () => connection.close(),
  };
}

function updateKinds(updates: AcpSessionNotification[]): string[] {
  return updates.map((notification) => notification.update.sessionUpdate);
}

//#endregion

describe('evaluateServePolicy', () => {
  it('checks deny before ask before allow, and defaults to allow', () => {
    const policy = {
      rules: [
        {
          tool: 'deploy',
          decision: 'deny',
        },
        {
          kind: 'execute',
          decision: 'ask',
        },
        {
          tool: 'deploy',
          decision: 'allow',
        },
      ],
    } as const;
    expect(
      evaluateServePolicy({
        policy,
        toolName: 'deploy',
        kind: 'execute',
      }),
    ).toBe('deny');
    expect(
      evaluateServePolicy({
        policy,
        toolName: 'run_tests',
        kind: 'execute',
      }),
    ).toBe('ask');
    expect(
      evaluateServePolicy({
        policy,
        toolName: 'search',
      }),
    ).toBe('allow');
    expect(
      evaluateServePolicy({
        policy: {
          default: 'deny',
        },
        toolName: 'anything',
      }),
    ).toBe('deny');
  });
});

describe('ServePermissionBroker', () => {
  it('denies on timeout — waiting must not become approval', async () => {
    const broker = new ServePermissionBroker(() => new Promise(() => {}));
    const reply = await broker.ask(
      {
        requestId: 'r1',
        sessionId: 's1',
        toolName: 'bash',
        title: 'bash',
      },
      10,
    );
    expect(reply.decision).toBe('deny');
    assert(reply.reason);
    expect(reply.reason).toContain('timed out');
  });

  it('cancelSession unwinds every park for that session only', async () => {
    const broker = new ServePermissionBroker(() => new Promise(() => {}));
    const askA = broker.ask(
      {
        requestId: 'ra',
        sessionId: 'session-a',
        toolName: 'bash',
        title: 'bash',
      },
      5_000,
    );
    const askB = broker.ask(
      {
        requestId: 'rb',
        sessionId: 'session-b',
        toolName: 'bash',
        title: 'bash',
      },
      50,
    );
    broker.cancelSession('session-a');
    const replyA = await askA;
    expect(replyA.decision).toBe('cancel');
    const replyB = await askB;
    expect(replyB.decision).toBe('deny');
  });
});

describe('toAcpAgent over loopback', () => {
  it('negotiates capabilities: no loadSession without history, image prompts on', async () => {
    const rig = await createServeRig({
      script: {},
    });
    expect(rig.connection.agentCapabilities.loadSession).toBe(false);
    expect(rig.connection.agentCapabilities.promptCapabilities?.image).toBe(true);
    await rig.close();
  });

  it('runs a prompt turn: text streams back and the turn ends end_turn', async () => {
    const rig = await createServeRig({
      script: {
        body: [
          sdkEvent('response.output_text.delta', {
            delta: 'Hello ',
          }),
          sdkEvent('response.output_text.delta', {
            delta: 'world',
          }),
          sdkEvent('response.reasoning.delta', {
            delta: 'thinking…',
          }),
        ],
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    const result = await session.prompt({
      content: [
        {
          type: 'text',
          text: 'Say hello',
        },
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('Hello world');

    // The prompt became a user item on the harness thread = the session id.
    expect(rig.mock.executed).toHaveLength(1);
    const call = rig.mock.executed[0];
    assert(call);
    expect(call.options?.threadId).toBe(session.sessionId);
    const input = frameworkCast<Item[]>(call.input);
    expect(input).toHaveLength(1);
    await rig.close();
  });

  it('reports tool calls with declared presentation, then completion', async () => {
    const rig = await createServeRig({
      script: {
        tools: [
          {
            name: 'edit_file',
            callId: 'call-1',
            args: {
              path: '/workspace/a.ts',
            },
          },
        ],
      },
      serve: {
        tools: [
          {
            name: 'edit_file',
            acp: {
              kind: 'edit',
              title: (args) => `Edit ${frameworkCast<Record<string, string>>(args).path}`,
              locations: (args) => [
                frameworkCast<Record<string, string>>(args).path,
              ],
            },
          },
        ],
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: [
        {
          type: 'text',
          text: 'edit it',
        },
      ],
    });
    await rig.mock.turnDone();

    const kinds = updateKinds(rig.updates);
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_call_update');
    const toolCall = rig.updates
      .map((notification) => notification.update)
      .find((update) => update.sessionUpdate === 'tool_call');
    assert(toolCall && toolCall.sessionUpdate === 'tool_call');
    expect(toolCall.title).toBe('Edit /workspace/a.ts');
    expect(toolCall.kind).toBe('edit');
    expect(toolCall.status).toBe('in_progress');
    expect(toolCall.locations).toEqual([
      {
        path: '/workspace/a.ts',
      },
    ]);
    expect(toolCall.rawInput).toEqual({
      path: '/workspace/a.ts',
    });
    const done = rig.updates
      .map((notification) => notification.update)
      .find((update) => update.sessionUpdate === 'tool_call_update');
    assert(done && done.sessionUpdate === 'tool_call_update');
    expect(done.status).toBe('completed');
    await rig.close();
  });

  it('forwards an ask over the wire and runs the tool when the client allows', async () => {
    const rig = await createServeRig({
      script: {
        tools: [
          {
            name: 'run_tests',
            callId: 'call-ask',
          },
        ],
      },
      serve: {
        permissions: {
          default: 'ask',
        },
      },
      // Noetic's own client answers session/request_permission from its policy.
      clientPermissions: {
        default: 'allow',
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    const result = await session.prompt({
      content: [
        {
          type: 'text',
          text: 'run the tests',
        },
      ],
    });
    await rig.mock.turnDone();

    expect(result.stopReason).toBe('end_turn');
    // Gated call went out as pending, then completed successfully after the grant.
    const toolCall = rig.updates
      .map((notification) => notification.update)
      .find((update) => update.sessionUpdate === 'tool_call');
    assert(toolCall && toolCall.sessionUpdate === 'tool_call');
    expect(toolCall.status).toBe('pending');
    const completed = rig.updates
      .map((notification) => notification.update)
      .filter((update) => update.sessionUpdate === 'tool_call_update')
      .at(-1);
    assert(completed && completed.sessionUpdate === 'tool_call_update');
    expect(completed.status).toBe('completed');
    await rig.close();
  });

  it('a client rejection denies the tool call and the turn still completes', async () => {
    const rig = await createServeRig({
      script: {
        tools: [
          {
            name: 'run_tests',
            callId: 'call-deny',
          },
        ],
      },
      serve: {
        permissions: {
          default: 'ask',
          askTimeoutMs: 2_000,
        },
      },
      clientPermissions: {
        default: 'deny',
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    const result = await session.prompt({
      content: [
        {
          type: 'text',
          text: 'run the tests',
        },
      ],
    });
    await rig.mock.turnDone();

    expect(result.stopReason).toBe('end_turn');
    const completed = rig.updates
      .map((notification) => notification.update)
      .filter((update) => update.sessionUpdate === 'tool_call_update')
      .at(-1);
    assert(completed && completed.sessionUpdate === 'tool_call_update');
    expect(completed.status).toBe('failed');
    await rig.close();
  });

  it('an in-process onPermissionRequest answers without touching the wire', async () => {
    const prompts: string[] = [];
    const rig = await createServeRig({
      script: {
        tools: [
          {
            name: 'deploy',
            callId: 'call-host',
          },
        ],
      },
      serve: {
        permissions: {
          rules: [
            {
              tool: 'deploy',
              decision: 'ask',
            },
          ],
        },
        onPermissionRequest: async (prompt) => {
          prompts.push(prompt.toolName);
          return {
            decision: 'deny',
            reason: 'not today',
          };
        },
      },
      // The client would allow — proving the host hook answered instead.
      clientPermissions: {
        default: 'allow',
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: [
        {
          type: 'text',
          text: 'ship it',
        },
      ],
    });
    await rig.mock.turnDone();

    expect(prompts).toEqual([
      'deploy',
    ]);
    const completed = rig.updates
      .map((notification) => notification.update)
      .filter((update) => update.sessionUpdate === 'tool_call_update')
      .at(-1);
    assert(completed && completed.sessionUpdate === 'tool_call_update');
    expect(completed.status).toBe('failed');
    await rig.close();
  });

  it('session/cancel aborts the harness thread and the turn resolves cancelled', async () => {
    const rig = await createServeRig({
      script: {
        completeTurn: false,
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    const turn = session.prompt({
      content: [
        {
          type: 'text',
          text: 'never finishes',
        },
      ],
    });
    // Give the turn a beat to start before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session.cancel();

    // The connection layer surfaces the protocol truth — `stopReason:
    // 'cancelled'` — and the interpreter (spec 27) is what converts that into
    // the typed NoeticError for step consumers.
    const result = await turn;
    expect(result.stopReason).toBe('cancelled');
    expect(rig.mock.aborts).toEqual([
      'cancelled',
    ]);
    await rig.close();
  });

  it('routes slash commands through run() and executes its rewrite', async () => {
    const rig = await createServeRig({
      script: {},
      serve: {
        commands: [
          {
            name: 'plan',
            description: 'Plan only',
            run: (argsText) => `Plan only — do not edit files.\n\n${argsText}`,
          },
        ],
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: [
        {
          type: 'text',
          text: '/plan add dark mode',
        },
      ],
    });

    const call = rig.mock.executed[0];
    assert(call);
    const input = frameworkCast<Array<Record<string, unknown>>>(call.input);
    const first = input[0];
    assert(first);
    const content = frameworkCast<Array<Record<string, unknown>>>(first.content);
    expect(content[0]?.text).toBe('Plan only — do not edit files.\n\nadd dark mode');
    await rig.close();
  });

  it('advertises loadSession with history, seeds and replays on session/load', async () => {
    const stored: Item[] = [
      frameworkCast<Item>({
        id: 'm1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: 'earlier question',
          },
        ],
      }),
      frameworkCast<Item>({
        id: 'm2',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'earlier answer',
            annotations: [],
          },
        ],
      }),
    ];
    const saved: Array<{
      sessionId: string;
      item: Item;
    }> = [];
    const rig = await createServeRig({
      script: {},
      serve: {
        history: {
          load: async () => stored,
          save: async (sessionId, item) => {
            saved.push({
              sessionId,
              item,
            });
          },
        },
      },
    });
    expect(rig.connection.agentCapabilities.loadSession).toBe(true);

    const session = await rig.connection.loadSession({
      sessionId: 'resumed-session',
      cwd: '/workspace',
    });
    expect(session.sessionId).toBe('resumed-session');
    expect(rig.mock.seeded).toHaveLength(1);
    const seeded = rig.mock.seeded[0];
    assert(seeded);
    expect(seeded.threadId).toBe('resumed-session');
    expect(seeded.items).toHaveLength(2);

    const kinds = updateKinds(rig.updates);
    expect(kinds).toContain('user_message_chunk');
    expect(kinds).toContain('agent_message_chunk');
    await rig.close();
  });

  it('rejects a relative session cwd with invalid params', async () => {
    const rig = await createServeRig({
      script: {},
    });
    try {
      await rig.connection.newSession({
        cwd: 'relative/path',
      });
      expect.unreachable('relative cwd must be rejected');
    } catch (e) {
      expect(JSON.stringify(e)).toContain('absolute');
    }
    await rig.close();
  });

  it('rejects a prompt for an unknown session', async () => {
    // Drive the agent directly: the Noetic client keys prompts to its own
    // session objects, so a bogus session id needs the raw agent surface.
    const agent = toAcpAgent(serveMockHarness({}))(
      frameworkCast<Parameters<ReturnType<typeof toAcpAgent>>[0]>({
        sessionUpdate: async () => undefined,
      }),
    );
    try {
      await agent.prompt({
        sessionId: 'session-that-does-not-exist',
        prompt: [
          {
            type: 'text',
            text: 'hello',
          },
        ],
      });
      expect.unreachable('unknown session must be rejected');
    } catch (e) {
      expect(JSON.stringify(e)).toContain('unknown session');
    }
  });

  it('kind-based permission rules without tools are a loud config error', () => {
    const factory = toAcpAgent(serveMockHarness({}), {
      permissions: {
        rules: [
          {
            kind: 'execute',
            decision: 'deny',
          },
        ],
      },
    });
    expect(() =>
      factory(
        frameworkCast<Parameters<typeof factory>[0]>({
          sessionUpdate: async () => undefined,
        }),
      ),
    ).toThrow('kind-based permission rule');
  });

  it('slash-command args keep raw whitespace and later blocks survive the rewrite', async () => {
    const received: string[] = [];
    const rig = await createServeRig({
      script: {},
      serve: {
        commands: [
          {
            name: 'plan',
            description: 'Plan only',
            run: (argsText) => {
              received.push(argsText);
              return `REWRITTEN:${argsText}`;
            },
          },
        ],
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: [
        {
          type: 'text',
          text: '/plan first line\n\n```ts\nconst x = 1;\n```',
        },
        {
          type: 'text',
          text: 'attached context block',
        },
      ],
    });

    expect(received).toEqual([
      'first line\n\n```ts\nconst x = 1;\n```',
    ]);
    const call = rig.mock.executed[0];
    assert(call);
    const input = frameworkCast<Array<Record<string, unknown>>>(call.input);
    // The rewrite item plus the surviving second block's item.
    expect(input).toHaveLength(2);
    await rig.close();
  });
});

describe('loopback transport disposal', () => {
  it('closing the transport disposes live sessions on the served agent', async () => {
    const rig = await createServeRig({
      script: {},
    });
    await rig.connection.newSession({
      cwd: '/workspace',
    });
    await rig.close();
    // dispose() aborts every live session with the connection-closed reason —
    // the in-process path must clean up exactly like the stdio entry does.
    expect(rig.mock.aborts).toEqual([
      'connection closed',
    ]);
  });
});

describe('history save seam', () => {
  function streamingItem(overrides: { id: string; status: string; text?: string }): StreamingItem {
    return frameworkCast<StreamingItem>({
      id: overrides.id,
      type: 'message',
      role: 'assistant',
      status: overrides.status,
      content: [
        {
          type: 'output_text',
          text: overrides.text ?? 'hi',
          annotations: [],
        },
      ],
      isComplete: true,
    });
  }

  it('persists input before execute, dedupes the pump, and skips in_progress snapshots', async () => {
    const sequence: string[] = [];
    const saved: Array<Record<string, unknown>> = [];
    const rig = await createServeRig({
      script: {
        items: [
          // The stream re-emits an assistant message once at text-done with
          // status still in_progress, then finalized, then a buffer replay.
          streamingItem({
            id: 'm1',
            status: 'in_progress',
          }),
          streamingItem({
            id: 'm1',
            status: 'completed',
          }),
          streamingItem({
            id: 'm1',
            status: 'completed',
          }),
          streamingItem({
            id: 'm2',
            status: 'completed',
            text: 'second',
          }),
        ],
      },
      serve: {
        history: {
          load: async () => null,
          save: async (_sessionId, item) => {
            const record = frameworkCast<Record<string, unknown>>(item);
            sequence.push(`save:${String(record.id)}`);
            saved.push(record);
          },
        },
      },
    });
    // Interleave-order probe: execute lands in the same sequence log.
    const originalExecute = rig.mock.execute.bind(rig.mock);
    rig.mock.execute = (input, options) => {
      sequence.push('execute');
      return originalExecute(input, options);
    };

    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: [
        {
          type: 'text',
          text: 'hello',
        },
      ],
    });
    // Let the detached pump drain the finite item stream.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The user prompt item persisted BEFORE the turn executed.
    const executeIndex = sequence.indexOf('execute');
    const firstSaveIndex = sequence.findIndex((entry) => entry.startsWith('save:'));
    expect(firstSaveIndex).toBeGreaterThanOrEqual(0);
    expect(firstSaveIndex).toBeLessThan(executeIndex);

    // Pump: m1 exactly once (the FINALIZED copy), m2 once, nothing in_progress,
    // and no isComplete flag leaks into the store.
    const pumped = saved.filter((r) => r.id === 'm1' || r.id === 'm2');
    expect(pumped.map((r) => r.id)).toEqual([
      'm1',
      'm2',
    ]);
    for (const record of saved) {
      expect(record.status).not.toBe('in_progress');
      expect('isComplete' in record).toBe(false);
    }
    await rig.close();
  });

  it('dispose (via transport close) releases the item-stream consumer', async () => {
    const rig = await createServeRig({
      script: {
        holdItemStream: true,
      },
      serve: {
        history: {
          load: async () => null,
          save: async () => undefined,
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: [
        {
          type: 'text',
          text: 'start the pump',
        },
      ],
    });
    expect(rig.mock.itemStreamClosed()).toBe(false);
    await rig.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rig.mock.itemStreamClosed()).toBe(true);
  });
});

describe('permission edges', () => {
  it("the wire's cancelled outcome resolves the ask as cancel and denies the tool", async () => {
    const rig = await createServeRig({
      script: {
        tools: [
          {
            name: 'add',
            callId: 'call-cancel-outcome',
          },
        ],
      },
      serve: {
        permissions: {
          default: 'ask',
        },
      },
    });
    // The CLIENT answers permission requests with a cancelled outcome.
    const host = frameworkCast<{
      onPermissionRequest?: () => Promise<{
        decision: string;
      }>;
    }>(rig.host);
    host.onPermissionRequest = async () => ({
      decision: 'cancel',
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    const result = await session.prompt({
      content: [
        {
          type: 'text',
          text: 'add',
        },
      ],
    });
    await rig.mock.turnDone();
    expect(result.stopReason).toBe('end_turn');
    const completed = rig.updates
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate === 'tool_call_update')
      .at(-1);
    assert(completed && completed.sessionUpdate === 'tool_call_update');
    expect(completed.status).toBe('failed');
    await rig.close();
  });

  it('a throwing serve-side onPermissionRequest denies instead of hanging', async () => {
    const rig = await createServeRig({
      script: {
        tools: [
          {
            name: 'add',
            callId: 'call-throwing-host',
          },
        ],
      },
      serve: {
        permissions: {
          default: 'ask',
        },
        onPermissionRequest: async () => {
          throw new Error('approval surface crashed');
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    const result = await session.prompt({
      content: [
        {
          type: 'text',
          text: 'add',
        },
      ],
    });
    await rig.mock.turnDone();
    expect(result.stopReason).toBe('end_turn');
    const completed = rig.updates
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate === 'tool_call_update')
      .at(-1);
    assert(completed && completed.sessionUpdate === 'tool_call_update');
    expect(completed.status).toBe('failed');
    await rig.close();
  });

  it('session/cancel while an ask is parked unwinds the park and cancels the turn', async () => {
    const rig = await createServeRig({
      script: {
        tools: [
          {
            name: 'add',
            callId: 'call-parked',
          },
        ],
      },
      serve: {
        permissions: {
          default: 'ask',
          askTimeoutMs: 30_000,
        },
        // Never answers: only cancelSession can unwind this park.
        onPermissionRequest: () => new Promise(() => {}),
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    const turn = session.prompt({
      content: [
        {
          type: 'text',
          text: 'add',
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await session.cancel();
    const result = await turn;
    expect(result.stopReason).toBe('cancelled');
    // The open gated call was flushed at the abort boundary.
    const failed = rig.updates
      .map((n) => n.update)
      .find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'failed');
    expect(failed).toBeDefined();
    await rig.close();
  });

  it("the deny rule's refusal guidance names the serve policy", async () => {
    const rig = await createServeRig({
      script: {
        tools: [
          {
            name: 'deploy',
            callId: 'call-denied',
          },
        ],
      },
      serve: {
        permissions: {
          rules: [
            {
              tool: 'deploy',
              decision: 'deny',
            },
          ],
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: [
        {
          type: 'text',
          text: 'deploy',
        },
      ],
    });
    await rig.mock.turnDone();
    const decision = rig.mock.gateDecisions[0];
    assert(decision);
    expect(decision.action).toBe('deny');
    assert(decision.guidance);
    expect(decision.guidance).toContain('ACP serve policy');
    await rig.close();
  });
});

describe('session surface edges', () => {
  it('advertises commands (with input hints) after newSession and loadSession', async () => {
    const stored: Item[] = [];
    const rig = await createServeRig({
      script: {},
      serve: {
        commands: [
          {
            name: 'plan',
            description: 'Plan only',
            inputHint: 'what to plan',
          },
        ],
        history: {
          load: async () => stored,
          save: async () => undefined,
        },
      },
    });
    await rig.connection.newSession({
      cwd: '/workspace',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const advert = rig.updates
      .map((n) => n.update)
      .find((u) => u.sessionUpdate === 'available_commands_update');
    assert(advert && advert.sessionUpdate === 'available_commands_update');
    const command = advert.availableCommands[0];
    assert(command);
    expect(command.name).toBe('plan');
    expect(command.input?.hint).toBe('what to plan');

    await rig.connection.loadSession({
      sessionId: 'resumed',
      cwd: '/workspace',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const adverts = rig.updates
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate === 'available_commands_update');
    expect(adverts.length).toBeGreaterThanOrEqual(2);
    await rig.close();
  });

  it('an image-only prompt becomes one input_image item (data and uri forms)', async () => {
    const rig = await createServeRig({
      script: {},
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: [
        {
          type: 'image',
          data: 'AAAA',
          mimeType: 'image/png',
        },
      ],
    });
    await session.prompt({
      content: [
        {
          type: 'image',
          data: '',
          mimeType: 'image/png',
          uri: 'https://example.com/x.png',
        },
      ],
    });

    const inputs = rig.mock.executed.map((call) =>
      frameworkCast<
        Array<{
          content: Array<Record<string, unknown>>;
        }>
      >(call.input),
    );
    const firstPart = inputs[0]?.[0]?.content[0];
    assert(firstPart);
    expect(firstPart.type).toBe('input_image');
    expect(firstPart.imageUrl).toBe('data:image/png;base64,AAAA');
    const secondPart = inputs[1]?.[0]?.content[0];
    assert(secondPart);
    expect(secondPart.imageUrl).toBe('https://example.com/x.png');
    await rig.close();
  });

  it('two turns on one session release their event consumers (no leak)', async () => {
    const rig = await createServeRig({
      script: {},
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    for (const text of [
      'one',
      'two',
    ]) {
      const result = await session.prompt({
        content: [
          {
            type: 'text',
            text,
          },
        ],
      });
      expect(result.stopReason).toBe('end_turn');
    }
    expect(rig.mock.executed).toHaveLength(2);
    expect(rig.mock.liveEventConsumers()).toBe(0);
    await rig.close();
  });

  it('an empty prompt short-circuits to end_turn without executing', async () => {
    const rig = await createServeRig({
      script: {},
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    const result = await session.prompt({
      content: [],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(rig.mock.executed).toHaveLength(0);
    await rig.close();
  });

  it('mcpServers from session/new reach the per-session factory', async () => {
    let capturedServers: ReadonlyArray<unknown> | undefined;
    const transport = await loopbackTransport(
      toAcpAgent((init) => {
        capturedServers = init.mcpServers;
        return serveMockHarness({});
      }),
    )({
      cwd: '/workspace',
    });
    const connection = await openAcpConnection({
      agentId: 'noetic-serve',
      transport,
      host: {
        cwd: '/workspace',
        fs: new MemoryFs(),
        shell: new RecordingShell(),
        threadId: 'client-thread',
        onSessionUpdate: () => undefined,
      },
    });
    await connection.newSession({
      cwd: '/workspace',
      mcpServers: [
        {
          name: 'docs',
          command: '/usr/bin/docs-mcp',
          args: [],
          env: [],
        },
      ],
    });
    assert(capturedServers);
    expect(capturedServers).toHaveLength(1);
    await connection.close();
  });

  it('cancel for an unknown session is a silent no-op', async () => {
    const agent = toAcpAgent(serveMockHarness({}))(
      frameworkCast<Parameters<ReturnType<typeof toAcpAgent>>[0]>({
        sessionUpdate: async () => undefined,
      }),
    );
    await agent.cancel({
      sessionId: 'session-that-does-not-exist',
    });
  });
});

describe('slash command edges', () => {
  it('a command without run and an unknown command both pass through as text', async () => {
    const rig = await createServeRig({
      script: {},
      serve: {
        commands: [
          {
            name: 'passthru',
            description: 'no run',
          },
        ],
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    for (const text of [
      '/passthru keep me',
      '/nosuchcommand also kept',
    ]) {
      await session.prompt({
        content: [
          {
            type: 'text',
            text,
          },
        ],
      });
    }
    const texts = rig.mock.executed.map((call) => {
      const items = frameworkCast<
        Array<{
          content: Array<{
            text?: string;
          }>;
        }>
      >(call.input);
      return items[0]?.content[0]?.text;
    });
    expect(texts).toEqual([
      '/passthru keep me',
      '/nosuchcommand also kept',
    ]);
    await rig.close();
  });

  it('run may return Item[] and receives the session context', async () => {
    const seen: Array<{
      sessionId: string;
      cwd: string;
    }> = [];
    const rig = await createServeRig({
      script: {},
      serve: {
        commands: [
          {
            name: 'items',
            description: 'returns items',
            run: (_argsText, ctx) => {
              seen.push(ctx);
              return [
                frameworkCast<Item>({
                  id: 'command-item',
                  type: 'message',
                  role: 'user',
                  status: 'completed',
                  content: [
                    {
                      type: 'input_text',
                      text: 'from the command',
                    },
                  ],
                }),
              ];
            },
          },
        ],
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: [
        {
          type: 'text',
          text: '/items go',
        },
      ],
    });
    const input = frameworkCast<
      Array<{
        id: string;
      }>
    >(rig.mock.executed[0]?.input);
    expect(input[0]?.id).toBe('command-item');
    const ctx = seen[0];
    assert(ctx);
    expect(ctx.sessionId).toBe(session.sessionId);
    expect(ctx.cwd).toBe('/workspace');
    await rig.close();
  });
});

describe('loadSession edges', () => {
  it('replays stored tool calls with content, in order, before responding', async () => {
    const stored: Item[] = [
      frameworkCast<Item>({
        id: 'u1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: 'question',
          },
        ],
      }),
      frameworkCast<Item>({
        id: 'fc1',
        type: 'function_call',
        status: 'completed',
        name: 'add',
        callId: 'call-h1',
        arguments: '{"a":1}',
      }),
      frameworkCast<Item>({
        id: 'fo1',
        type: 'function_call_output',
        status: 'completed',
        callId: 'call-h1',
        output: '{"sum":2}',
      }),
      frameworkCast<Item>({
        id: 'a1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'answer',
            annotations: [],
          },
        ],
      }),
    ];
    const rig = await createServeRig({
      script: {},
      serve: {
        history: {
          load: async () => stored,
          save: async () => undefined,
        },
      },
    });
    await rig.connection.loadSession({
      sessionId: 'resumed',
      cwd: '/workspace',
    });
    // Everything replayed BEFORE loadSession resolved — assert immediately.
    const kinds = rig.updates.map((n) => n.update.sessionUpdate);
    expect(kinds).toEqual([
      'user_message_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ]);
    const toolUpdate = rig.updates
      .map((n) => n.update)
      .find((u) => u.sessionUpdate === 'tool_call_update');
    assert(toolUpdate && toolUpdate.sessionUpdate === 'tool_call_update');
    const content = toolUpdate.content?.[0];
    assert(content && content.type === 'content' && content.content.type === 'text');
    expect(content.content.text).toContain('sum');
    await rig.close();
  });

  it('rejects load without history, for an unknown id, and for a live session', async () => {
    // No history configured → method not found.
    const bare = toAcpAgent(serveMockHarness({}))(
      frameworkCast<Parameters<ReturnType<typeof toAcpAgent>>[0]>({
        sessionUpdate: async () => undefined,
      }),
    );
    assert(bare.loadSession);
    try {
      await bare.loadSession({
        sessionId: 'x',
        cwd: '/workspace',
        mcpServers: [],
      });
      expect.unreachable('load without history must reject');
    } catch (e) {
      expect(JSON.stringify(e)).toContain('-32601');
    }

    // Unknown id (load → null) and live-session guard, over the wire.
    const rig = await createServeRig({
      script: {},
      serve: {
        history: {
          load: async (sessionId) => (sessionId === 'known' ? [] : null),
          save: async () => undefined,
        },
      },
    });
    try {
      await rig.connection.loadSession({
        sessionId: 'never-stored',
        cwd: '/workspace',
      });
      expect.unreachable('unknown session id must reject');
    } catch (e) {
      expect(JSON.stringify(e)).toContain('unknown session');
    }
    const live = await rig.connection.loadSession({
      sessionId: 'known',
      cwd: '/workspace',
    });
    try {
      await rig.connection.loadSession({
        sessionId: live.sessionId,
        cwd: '/workspace',
      });
      expect.unreachable('live session reload must reject');
    } catch (e) {
      expect(JSON.stringify(e)).toContain('already active');
    }
    await rig.close();
  });
});

describe('gate failure direction through the real lifecycle', () => {
  it('a wedged broker denies the call instead of abstaining into approval', async () => {
    const { beforeToolCallLayers, createLayerStateStore } = await import('@noetic-tools/context');
    const { createServePermissionLayer } = await import('../src/serve-permissions');
    const brokenBroker = frameworkCast<Parameters<typeof createServePermissionLayer>[0]['broker']>({
      ask: () => {
        throw new Error('broker wedged');
      },
    });
    const layer = createServePermissionLayer({
      sessionId: 's1',
      policy: {
        default: 'ask',
      },
      broker: brokenBroker,
      presentation: {
        kindOf: () => undefined,
        titleOf: (name: string) => name,
      },
    });
    const decision = await beforeToolCallLayers({
      layers: [
        layer,
      ],
      toolName: 'deploy',
      toolArgs: {},
      callId: 'call-1',
      ctx: frameworkCast<ExecutionContext>({
        executionId: 'exec-1',
        threadId: 'thread-1',
      }),
      store: createLayerStateStore(),
    });
    expect(decision.action).toBe('deny');
  });
});
