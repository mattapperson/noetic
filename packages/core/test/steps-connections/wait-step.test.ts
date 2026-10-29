// `step.wait` (spec 35 § Steps): listen first, run `around`, then wait for the
// first event the filter accepts; gaps, ended streams, timeouts and aborts.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  ConnectionEvent,
  ContextData,
  NoeticError,
  StepWaitOutput,
} from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { runCode, step } from '../../src/builders/step-builders';
import { stepChildren } from '../../src/interpreter/step-walk';
import { capturingContext, FakeRegistry, harnessWith } from './_helpers';

//#region Helpers

function expectConfigCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected ${code}`);
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe(code);
  }
}

async function expectKind(promise: Promise<unknown>, kind: NoeticError['kind']): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected ${kind}`);
  } catch (e) {
    assert(isNoeticError(e));
    expect(e.noeticError.kind).toBe(kind);
  }
}

/** A registry whose `team` connection answers `chat.reply` by emitting `chat.message.created` events. */
function chatRegistry(texts: string[]): FakeRegistry {
  const registry: FakeRegistry = new FakeRegistry({
    team: {
      ops: {
        'chat.reply': () => {
          for (const text of texts) {
            registry.emit('team', 'chat.message.created', {
              text,
            });
          }
          return {
            posted: true,
          };
        },
      },
    },
  });
  return registry;
}

const PayloadSchema = z.object({
  text: z.string(),
});

/** The text of a chat message event. */
function textOf(event: ConnectionEvent): string {
  return PayloadSchema.parse(event.payload).text;
}

//#endregion

describe('step.wait builder', () => {
  it('builds a wait step whose around steps are its children', () => {
    const ask = step.call({
      id: 'ask',
      connection: 'team',
      op: 'chat.reply',
    });
    const built = step.wait({
      id: 'approval',
      connection: 'team',
      event: 'chat.message.created',
      around: ask,
      timeoutMs: 1e3,
    });
    expect(built.kind).toBe('wait');
    expect(stepChildren(built)).toEqual([
      ask,
    ]);
  });

  it('rejects a timeout that is not positive with CONNECTION_INVALID (boundary 0)', () => {
    expectConfigCode(
      () =>
        step.wait({
          id: 'w',
          connection: 'team',
          event: 'x.y',
          timeoutMs: 0,
        }),
      'CONNECTION_INVALID',
    );
  });

  it('accepts the smallest positive timeout (boundary 1)', () => {
    expect(
      step.wait({
        id: 'w',
        connection: 'team',
        event: 'x.y',
        timeoutMs: 1,
      }).timeoutMs,
    ).toBe(1);
  });

  it('rejects a missing event with CONNECTION_INVALID', () => {
    expectConfigCode(
      () =>
        step.wait({
          id: 'w',
          connection: 'team',
          event: '',
          timeoutMs: 10,
        }),
      'CONNECTION_INVALID',
    );
  });

  it('rejects an empty id with EMPTY_STEP_ID', () => {
    expectConfigCode(
      () =>
        step.wait({
          id: '',
          connection: 'team',
          event: 'x.y',
          timeoutMs: 10,
        }),
      'EMPTY_STEP_ID',
    );
  });
});

describe('executeWait', () => {
  it('listens before around, so the event around causes is caught', async () => {
    const registry = chatRegistry([
      'hello',
      'I approve',
    ]);
    const harness = harnessWith(registry, 'wait-agent');
    const { ctx } = capturingContext(harness);
    const wait = step.wait<ContextData, string, unknown>({
      id: 'approval',
      connection: 'team',
      event: 'chat.message.created',
      filter: (e: ConnectionEvent) => /approve/i.test(textOf(e)),
      around: step.call({
        id: 'ask',
        connection: 'team',
        op: 'chat.reply',
      }),
      timeoutMs: 1e3,
    });
    const output = await harness.run(wait, 'thread-1', ctx);
    const result: StepWaitOutput<unknown, unknown> = output;
    expect(result.event.payload).toEqual({
      text: 'I approve',
    });
    expect(result.around).toEqual({
      posted: true,
    });
    expect(registry.listens).toEqual([
      {
        connection: 'team',
        event: 'chat.message.created',
        cursor: null,
      },
    ]);
    // The stream is closed once the wait returns.
    expect(registry.listenerCount('team')).toBe(0);
    expect(registry.resolves[0]?.requirement).toEqual({
      events: [
        'chat.message.created',
      ],
    });
  });

  it('passes the step input to the filter and runs an around array in sequence', async () => {
    const registry = chatRegistry([
      'for thread-2',
    ]);
    const harness = harnessWith(registry);
    const seen: string[] = [];
    const first = runCode<ContextData, string, string>({
      id: 'first',
      execute: async (input) => `${input}+first`,
    });
    const second = runCode<ContextData, string, string>({
      id: 'second',
      execute: async (input) => {
        seen.push(input);
        return `${input}+second`;
      },
    });
    const ask = step.call({
      id: 'ask',
      connection: 'team',
      op: 'chat.reply',
    });
    const output = await harness.run(
      step.wait<ContextData, string, unknown>({
        id: 'w',
        connection: 'team',
        event: 'chat.message.created',
        filter: (e, input) => textOf(e).includes(input),
        around: [
          first,
          second,
          ask,
        ],
        timeoutMs: 1e3,
      }),
      'thread-2',
      harness.createContext(),
    );
    expect(seen).toEqual([
      'thread-2+first',
    ]);
    expect(output.around).toEqual({
      posted: true,
    });
  });

  it('ignores events of other types', async () => {
    const registry = new FakeRegistry({
      team: {
        ops: {
          'chat.reply': () => {
            registry.emit('team', 'chat.reaction.added', {});
            registry.emit('team', 'chat.message.created', {
              text: 'ok',
            });
            return null;
          },
        },
      },
    });
    const harness = harnessWith(registry);
    const output = await harness.run(
      step.wait({
        id: 'w',
        connection: 'team',
        event: 'chat.message.created',
        around: step.call({
          id: 'ask',
          connection: 'team',
          op: 'chat.reply',
        }),
        timeoutMs: 1e3,
      }),
      '',
      harness.createContext(),
    );
    expect(output.event.type).toBe('chat.message.created');
    expect(output).not.toHaveProperty('around', undefined);
  });

  it('reports a gap as stream_changed and keeps waiting', async () => {
    const registry: FakeRegistry = new FakeRegistry({
      team: {
        ops: {
          'chat.reply': () => {
            registry.push('team', {
              type: 'gap',
              reason: 'server skipped events',
            });
            registry.emit('team', 'chat.message.created', {
              text: 'ok',
            });
            return null;
          },
        },
      },
    });
    const harness = harnessWith(registry, 'gap-agent');
    const { ctx } = capturingContext(harness);
    const output = await harness.run(
      step.wait({
        id: 'w',
        connection: 'team',
        event: 'chat.message.created',
        around: step.call({
          id: 'ask',
          connection: 'team',
          op: 'chat.reply',
        }),
        timeoutMs: 1e3,
      }),
      '',
      ctx,
    );
    expect(output.event.payload).toEqual({
      text: 'ok',
    });
  });

  it('fails with connection_unavailable when the stream ends', async () => {
    const registry: FakeRegistry = new FakeRegistry({
      team: {
        ops: {
          'chat.reply': () => {
            registry.push('team', {
              type: 'terminated',
              reason: 'subscription revoked',
            });
            return null;
          },
        },
      },
    });
    const harness = harnessWith(registry, 'ended-agent');
    const { ctx } = capturingContext(harness);
    await expectKind(
      harness.run(
        step.wait({
          id: 'w',
          connection: 'team',
          event: 'chat.message.created',
          around: step.call({
            id: 'ask',
            connection: 'team',
            op: 'chat.reply',
          }),
          timeoutMs: 1e3,
        }),
        '',
        ctx,
      ),
      'connection_unavailable',
    );
  });

  it('fails with step_failed when no matching event arrives within timeoutMs', async () => {
    const registry = new FakeRegistry({
      team: {},
    });
    const harness = harnessWith(registry);
    const started = Date.now();
    await expectKind(
      harness.run(
        step.wait({
          id: 'w',
          connection: 'team',
          event: 'chat.message.created',
          timeoutMs: 20,
        }),
        '',
        harness.createContext(),
      ),
      'step_failed',
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(registry.listenerCount('team')).toBe(0);
  });

  it('fails with cancelled when the run is aborted while waiting', async () => {
    const registry = new FakeRegistry({
      team: {},
    });
    const harness = harnessWith(registry);
    const ctx = harness.createContext();
    setTimeout(() => ctx.abort('stop'), 10);
    await expectKind(
      harness.run(
        step.wait({
          id: 'w',
          connection: 'team',
          event: 'chat.message.created',
          timeoutMs: 5e3,
        }),
        '',
        ctx,
      ),
      'cancelled',
    );
  });

  it('closes the stream and rethrows when around fails', async () => {
    const registry = new FakeRegistry({
      team: {},
    });
    const harness = harnessWith(registry);
    const boom = runCode<ContextData, string, string>({
      id: 'boom',
      execute: async () => {
        throw new Error('around failed');
      },
    });
    await expect(
      harness.run(
        step.wait({
          id: 'w',
          connection: 'team',
          event: 'chat.message.created',
          around: boom,
          timeoutMs: 1e3,
        }),
        '',
        harness.createContext(),
      ),
    ).rejects.toThrow();
    expect(registry.listenerCount('team')).toBe(0);
  });
});
