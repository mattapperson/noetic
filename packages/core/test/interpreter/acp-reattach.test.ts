/**
 * A resumed ACP step reattaches to the agent its earlier host left running,
 * when the agent outlived that host: it collects the turn in flight — every
 * update of it, then its result — instead of prompting again, and falls back
 * to reloading or starting over when the agent is gone.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type {
  AcpAgent,
  AcpAgentConnection,
  AcpConnectOptions,
  AcpPromptOptions,
  AcpSession,
  AcpTurnResult,
  AcpWhenHostExits,
} from '@noetic-tools/types';
import {
  AcpConnectError,
  frameworkCast,
  isNoeticConfigError,
  isNoeticError,
} from '@noetic-tools/types';
import { step } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { ACP_RESUME_NOTICE } from '../../src/interpreter/acp-resume';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { makeMessage } from '../_helpers';

//#region Fixtures

const HANDLE = {
  kind: 'test-keeper',
  address: 'kept-agent-1',
};

interface Seen {
  connects: AcpConnectOptions[];
  newSessions: number;
  prompts: string[];
}

function seen(): Seen {
  return {
    connects: [],
    newSessions: 0,
    prompts: [],
  };
}

function promptText(prompt: AcpPromptOptions): string {
  return prompt.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

function result(text: string): AcpTurnResult {
  return {
    stopReason: 'end_turn',
    items: [
      makeMessage('assistant', text),
    ],
    text,
  };
}

/**
 * An agent that can be reattached. A first connection's prompt never ends (its
 * host dies); a reattached one collects `collected`, or nothing (`undefined`:
 * no turn was running), and a prompt after that answers `prompted`.
 */
function keptAgent(opts: {
  seen: Seen;
  collected?: string;
  /** The agent is gone: reattaching fails with `AcpConnectError`. */
  gone?: boolean;
  /** Reattaching fails some other way: the old turn may still be there. */
  broken?: boolean;
  /** What its sessions are opened with, and what it would open one with now. */
  fingerprint?: string;
}): AcpAgent {
  return {
    specificationVersion: 'acp-v1',
    agentId: 'kept',
    async connect(connect): Promise<AcpAgentConnection> {
      opts.seen.connects.push(connect);
      if (connect.reattach && opts.gone) {
        throw new AcpConnectError({
          agentId: 'kept',
          message: 'the keeper is gone',
        });
      }
      if (connect.reattach && opts.broken) {
        throw new Error('the keeper refused the token');
      }
      const session = (sessionId: string, reattached: boolean): AcpSession => ({
        sessionId,
        ...(opts.fingerprint === undefined || reattached
          ? {}
          : {
              fingerprint: opts.fingerprint,
            }),
        availableCommands: [],
        async prompt(prompt) {
          opts.seen.prompts.push(promptText(prompt));
          if (!reattached) {
            // The host dies mid-turn: the turn ends only when the test lets go.
            return await new Promise<AcpTurnResult>((resolve) => {
              prompt.signal?.addEventListener('abort', () =>
                resolve({
                  stopReason: 'cancelled',
                  items: [],
                  text: '',
                }),
              );
            });
          }
          return result('prompted');
        },
        ...(reattached
          ? {
              async resumeTurn() {
                const text = opts.collected;
                if (text === undefined) {
                  return undefined;
                }
                for (const part of text.split(' ')) {
                  connect.host.onSessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: 'agent_message_chunk',
                      content: {
                        type: 'text',
                        text: part,
                      },
                    },
                  });
                }
                return result(text);
              },
            }
          : {}),
        async cancel() {},
        async setMode() {},
        async setModel() {},
      });
      return {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: 1,
        fingerprintFor: (): string => opts.fingerprint ?? 'fake',
        reattach: HANDLE,
        async authenticate() {},
        async newSession() {
          opts.seen.newSessions += 1;
          return session('kept-session', false);
        },
        async loadSession(load) {
          return session(load.sessionId, false);
        },
        ...(connect.reattach
          ? {
              async attachSession(sessionId: string) {
                return session(sessionId, true);
              },
            }
          : {}),
        async close() {},
      };
    },
  };
}

function harnessOn(storage: StorageAdapter, killAgentsOnExit?: boolean): AgentHarness {
  return new AgentHarness({
    name: 'acp-reattach',
    params: {},
    killAgentsOnExit,
    environment: {
      storage: {
        adapter: storage,
      },
    },
  });
}

function coder(agent: AcpAgent) {
  return step.acpAgent({
    id: 'code',
    agent,
    prompt: 'Add the feature.',
  });
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2e3 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert(done());
}

/** Runs a test started and must end, so no turn outlives its test. */
const running: Array<{
  ctx: {
    abort(reason?: string): void;
  };
  done: Promise<unknown>;
}> = [];

afterEach(async () => {
  for (const run of running.splice(0)) {
    run.ctx.abort('test over');
    await run.done;
  }
});

/** Run the step until its agent is mid-turn, as a host that then dies leaves it. */
async function cutOff(storage: StorageAdapter, first: Seen, fingerprint?: string): Promise<string> {
  const harness = harnessOn(storage);
  const ctx = harness.createContext();
  const done = harness
    .run(
      coder(
        keptAgent({
          seen: first,
          fingerprint,
        }),
      ),
      undefined,
      ctx,
    )
    .catch(() => undefined);
  running.push({
    ctx,
    done,
  });
  await until(() => first.prompts.length === 1);
  return ctx.id;
}

interface RecordedEvent {
  type: string;
  data: Record<string, unknown>;
}

async function resume({
  storage,
  executionId,
  agent,
  events,
}: {
  storage: StorageAdapter;
  executionId: string;
  agent: AcpAgent;
  events: RecordedEvent[];
}): Promise<unknown> {
  const harness = harnessOn(storage);
  const ctx = await harness.restore(executionId);
  assert(ctx);
  let settle: (value: unknown) => void = () => undefined;
  const done = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  running.push({
    ctx,
    done,
  });
  frameworkCast<{
    _broadcaster: unknown;
  }>(ctx)._broadcaster = {
    emit(event: RecordedEvent) {
      events.push(event);
    },
  };
  try {
    return await harness.run(coder(agent), undefined, ctx);
  } finally {
    settle(undefined);
  }
}

//#endregion

describe('an ACP step resumed while its agent still runs', () => {
  it('reattaches and collects the turn in flight instead of prompting again', async () => {
    const storage = createInMemoryStorage();
    const first = seen();
    const executionId = await cutOff(storage, first);
    expect(first.connects[0]?.whenHostExits).toBe('keep');

    const after = seen();
    const events: RecordedEvent[] = [];
    const output = await resume({
      storage,
      executionId,
      agent: keptAgent({
        seen: after,
        collected: 'finished while away',
      }),
      events: events,
    });

    expect(output).toBe('finished while away');
    expect(after.connects[0]?.reattach).toEqual(HANDLE);
    expect(after.newSessions).toBe(0);
    expect(after.prompts).toEqual([]);
    // The collected turn streams as this step's output.
    const deltas = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => String(e.data.delta));
    expect(deltas.join(' ')).toBe('finished while away');
  });

  it('prompts, behind the resume notice, when no turn was running', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, seen());

    const after = seen();
    const output = await resume({
      storage,
      executionId,
      agent: keptAgent({
        seen: after,
      }),
      events: [],
    });

    expect(output).toBe('prompted');
    expect(after.newSessions).toBe(0);
    expect(after.prompts).toHaveLength(1);
    expect(after.prompts[0]).toContain(ACP_RESUME_NOTICE);
  });

  it('starts over when the agent is gone', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, seen());

    const after = seen();
    const gone = keptAgent({
      seen: after,
      gone: true,
    });
    // The fallback connection's prompt would hang like the first one; stop at it.
    void resume({
      storage,
      executionId,
      agent: gone,
      events: [],
    }).catch(() => undefined);
    await until(() => after.prompts.length === 1);

    expect(after.connects).toHaveLength(2);
    expect(after.connects[0]?.reattach).toEqual(HANDLE);
    expect(after.connects[1]?.reattach).toBeUndefined();
    expect(after.newSessions).toBe(1);
  });
});

describe('killAgentsOnExit', () => {
  it.each([
    [
      undefined,
      'keep',
    ],
    [
      false,
      'keep',
    ],
    [
      true,
      'stop',
    ],
  ] satisfies Array<
    [
      boolean | undefined,
      AcpWhenHostExits,
    ]
  >)('killAgentsOnExit: %p asks the agent to %s on host exit', async (kill, expected) => {
    const harness = harnessOn(createInMemoryStorage(), kill);
    const connects = seen();
    const agent = keptAgent({
      seen: connects,
    });
    const ctx = harness.createContext();
    const done = harness.run(coder(agent), undefined, ctx).catch(() => undefined);
    running.push({
      ctx,
      done,
    });
    await until(() => connects.connects.length === 1);
    expect(connects.connects[0]?.whenHostExits).toBe(expected);
  });
});

describe('an ACP step that cannot safely reattach', () => {
  it('fails rather than start over when reattaching fails some other way', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, seen());

    const after = seen();
    const error = await resume({
      storage,
      executionId,
      agent: keptAgent({
        seen: after,
        broken: true,
      }),
      events: [],
    }).catch((e: unknown) => e);

    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('step_failed');
    expect(after.newSessions).toBe(0);
    expect(after.prompts).toEqual([]);
  });

  it('fails when the session was opened with other instructions or settings', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, seen(), 'opened-with-A');

    const after = seen();
    const error = await resume({
      storage,
      executionId,
      agent: keptAgent({
        seen: after,
        collected: 'never collected',
        fingerprint: 'would-open-with-B',
      }),
      events: [],
    }).catch((e: unknown) => e);

    assert(isNoeticConfigError(error));
    expect(error.code).toBe('ACP_SESSION_SETTING_CONFLICT');
    expect(after.prompts).toEqual([]);
  });

  it('collects the turn when the settings match', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, seen(), 'same');

    const output = await resume({
      storage,
      executionId,
      agent: keptAgent({
        seen: seen(),
        collected: 'done while away',
        fingerprint: 'same',
      }),
      events: [],
    });
    expect(output).toBe('done while away');
  });
});
