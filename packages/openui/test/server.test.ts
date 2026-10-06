import { describe, expect, test } from 'bun:test';
import type { AgentHarnessContract, Item, StreamEvent } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { openUiSurface } from '../src';
import type { OpenUiRequest } from '../src/server';
import {
  encodeSseFrame,
  noeticStreamAdapter,
  parseSseFrame,
  serveOpenUi,
  snapshotMessage,
  translateStreamEvent,
} from '../src/server';
import { makeExecCtx, makeStorage, testLibrary } from './_helpers';

const AGENT = 'agent';

/** The 202 echo body shape a POST {event} returns. */
const EventEchoSchema = z.object({
  accepted: z.boolean(),
  seq: z.number(),
  version: z.number(),
});

function sdk(type: string, data: Record<string, unknown> = {}): StreamEvent {
  return {
    source: 'sdk',
    type,
    data,
  };
}

function framework(type: string, data: Record<string, unknown> = {}): StreamEvent {
  return {
    source: 'framework',
    type: `${AGENT}:${type}`,
    data,
  };
}

describe('translateStreamEvent', () => {
  test('maps openui.* framework events to statement/fragment messages', () => {
    expect(
      translateStreamEvent(
        framework('openui.node', {
          ref: 'root',
          kind: 'component',
          source: 'root = Card("Hi")',
        }),
        AGENT,
      ),
    ).toEqual({
      type: 'statement',
      ref: 'root',
      kind: 'component',
      source: 'root = Card("Hi")',
    });

    expect(
      translateStreamEvent(
        framework('openui.fragment', {
          callId: 'call-1',
          dialect: 'openui-lang/0.5',
          source: 'root = Progress(40)',
        }),
        AGENT,
      ),
    ).toEqual({
      type: 'fragment',
      callId: 'call-1',
      dialect: 'openui-lang/0.5',
      source: 'root = Progress(40)',
    });
  });

  test('maps turn completion and error; ignores per-model-call completions', () => {
    // The turn boundary — not a single model call — terminates the stream.
    expect(translateStreamEvent(framework('turn_completed'), AGENT)).toEqual({
      type: 'done',
    });
    // A tool-using turn ends the tool round with its own response.completed
    // *before* the render is emitted; that must NOT terminate the stream.
    expect(translateStreamEvent(sdk('response.completed'), AGENT)).toBeNull();
    expect(
      translateStreamEvent(
        sdk('error', {
          message: 'boom',
        }),
        AGENT,
      ),
    ).toEqual({
      type: 'error',
      message: 'boom',
    });
    expect(
      translateStreamEvent(
        sdk('response.output_text.delta', {
          delta: 'x',
        }),
        AGENT,
      ),
    ).toBeNull();
    // Only the `openui.*` framework suffixes carry UI payloads; every other
    // framework event from this agent is passed over. Pair the two directions so
    // the negative case can't start passing vacuously against a renamed event.
    expect(
      translateStreamEvent(
        framework('model_call_started', {
          model: 'openai/gpt-4o-mini',
        }),
        AGENT,
      ),
    ).toBeNull();
    expect(
      translateStreamEvent(
        framework('openui.node', {
          ref: 'root',
          kind: 'component',
          source: 'root = Card("Hi")',
        }),
        AGENT,
      ),
    ).not.toBeNull();
    // a differently-named agent's events must not be claimed
    expect(
      translateStreamEvent(
        {
          source: 'framework',
          type: 'other:openui.node',
          data: {},
        },
        AGENT,
      ),
    ).toBeNull();
  });
});

describe('SSE framing round-trip', () => {
  test('encode → parse recovers the message', () => {
    const message = snapshotMessage({
      document: {
        dialect: 'openui-lang/0.5',
        root: 'root',
        assignments: {},
        order: [],
        diagnostics: [],
      },
      vars: {
        tab: 'a',
      },
      interactions: [],
      version: 3,
      appliedEventSeq: -1,
    });
    const frame = encodeSseFrame(message);
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(parseSseFrame(frame.trimEnd())).toEqual(message);
  });

  test('parseSseFrame rejects non-data lines and malformed payloads', () => {
    expect(parseSseFrame(': comment')).toBeNull();
    expect(parseSseFrame('data:')).toBeNull();
    expect(parseSseFrame('data: {"type":"unknown"}')).toBeNull();
  });
});

describe('noeticStreamAdapter', () => {
  test('frames prompt and event bodies', () => {
    const adapter = noeticStreamAdapter();
    expect(adapter.requestBody('hi')).toEqual({
      prompt: 'hi',
    });
    expect(
      adapter.eventBody({
        kind: 'submit',
      }),
    ).toEqual({
      event: {
        kind: 'submit',
      },
    });
  });
});

//#region serveOpenUi

interface FakeHarness {
  executed: Array<{
    input: unknown;
  }>;
  events: StreamEvent[];
}

function makeFakeHarness(events: StreamEvent[] = []): AgentHarnessContract & FakeHarness {
  const executed: Array<{
    input: unknown;
  }> = [];
  const partial = {
    executed,
    events,
    config: {
      name: AGENT,
    },
    async execute(input: Item | string) {
      executed.push({
        input,
      });
    },
    async *getFullStream() {
      for (const event of events) {
        yield event;
      }
    },
  };
  // Only the fields serveOpenUi touches are implemented; the rest are unused
  // in these transport tests.
  return frameworkCast<AgentHarnessContract & FakeHarness>(partial);
}

function req(method: string, body?: unknown): OpenUiRequest {
  return {
    method,
    async json() {
      return body;
    },
  };
}

async function initSurface() {
  const surface = openUiSurface({
    library: testLibrary(),
  });
  const init = surface.hooks.init;
  if (!init) {
    throw new Error('init');
  }
  await init({
    storage: makeStorage(),
    scopeKey: 'thread-1',
    ctx: makeExecCtx(),
  });
  return surface;
}

async function drain(response: Response): Promise<string> {
  return await response.text();
}

describe('serveOpenUi', () => {
  test('GET returns a snapshot even before any render', async () => {
    const surface = await initSurface();
    const handler = serveOpenUi(makeFakeHarness(), {
      surface,
    });
    const res = await handler(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      type: 'snapshot',
      version: 0,
    });
  });

  test('POST event validates and ingests as a ui-event item (202)', async () => {
    const surface = await initSurface();
    const harness = makeFakeHarness();
    const handler = serveOpenUi(harness, {
      surface,
    });
    const res = await handler(
      req('POST', {
        event: {
          kind: 'submit',
          ref: 'checkout',
          seq: 0,
        },
      }),
    );
    expect(res.status).toBe(202);
    expect(harness.executed).toHaveLength(1);
    const item = harness.executed[0]?.input;
    expect(item).toBeDefined();
    expect(typeof item === 'object' && item !== null && 'uiEvent' in item).toBe(true);
  });

  test('POST malformed event → 400', async () => {
    const surface = await initSurface();
    const handler = serveOpenUi(makeFakeHarness(), {
      surface,
    });
    const res = await handler(
      req('POST', {
        event: {
          kind: 'not-a-kind',
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  test('POST prompt runs a turn and streams a snapshot then translated events', async () => {
    const surface = await initSurface();
    const harness = makeFakeHarness([
      // A tool-using turn: the tool round completes first (must NOT terminate),
      // then the render statements stream, then the turn completes.
      sdk('response.completed'),
      framework('openui.node', {
        ref: 'root',
        kind: 'component',
        source: 'root = Card("Hi")',
      }),
      framework('turn_completed'),
    ]);
    const handler = serveOpenUi(harness, {
      surface,
    });
    const res = await handler(
      req('POST', {
        prompt: 'build a dashboard',
      }),
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await drain(res);
    const frames = text
      .split('\n\n')
      .filter((f) => f.length > 0)
      .map((f) => parseSseFrame(f));
    expect(frames[0]?.type).toBe('snapshot');
    expect(frames[1]).toMatchObject({
      type: 'statement',
      ref: 'root',
    });
    expect(frames[2]?.type).toBe('done');
    expect(harness.executed[0]?.input).toBe('build a dashboard');
  });

  test('POST without prompt or event → 400; non-POST/GET → 405', async () => {
    const surface = await initSurface();
    const handler = serveOpenUi(makeFakeHarness(), {
      surface,
    });
    expect((await handler(req('POST', {}))).status).toBe(400);
    expect((await handler(req('DELETE'))).status).toBe(405);
  });
});

//#endregion

describe('serveOpenUi hardening', () => {
  test('concurrent prompt POSTs on one thread get 409 until the stream finishes', async () => {
    const surface = await initSurface();
    // Gate the event stream so the turn stays "in flight" until we release it.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeFakeHarness([]);
    const gated = frameworkCast<AgentHarnessContract & FakeHarness>({
      ...harness,
      async *getFullStream() {
        await gate;
        yield framework('turn_completed', {
          turnId: 't1',
        });
      },
    });
    const handler = serveOpenUi(gated, {
      surface,
    });
    const first = await handler(
      req('POST', {
        prompt: 'render something',
      }),
    );
    expect(first.status).toBe(200);
    // Stream still open — a second prompt must be rejected, not interleaved.
    const second = await handler(
      req('POST', {
        prompt: 'another prompt',
      }),
    );
    expect(second.status).toBe(409);
    // Completing the turn releases the slot.
    release?.();
    await drain(first);
    const third = await handler(
      req('POST', {
        prompt: 'after done',
      }),
    );
    expect(third.status).toBe(200);
    release?.();
    await drain(third);
  });

  test('separate handlers share the prompt lock for one harness and thread', async () => {
    const surface = await initSurface();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = frameworkCast<AgentHarnessContract & FakeHarness>({
      ...makeFakeHarness([]),
      async *getFullStream() {
        await gate;
        yield framework('turn_completed', {
          turnId: 't1',
        });
      },
    });
    const firstHandler = serveOpenUi(harness, {
      surface,
      threadId: 'shared',
    });
    const secondHandler = serveOpenUi(harness, {
      surface,
      threadId: 'shared',
    });
    const first = await firstHandler(
      req('POST', {
        prompt: 'first',
      }),
    );
    expect(
      (
        await secondHandler(
          req('POST', {
            prompt: 'second',
          }),
        )
      ).status,
    ).toBe(409);
    release?.();
    await drain(first);
  });

  test('UI-event POSTs are never blocked by an active stream and echo seq+version', async () => {
    const surface = await initSurface();
    const harness = makeFakeHarness([
      framework('turn_completed', {
        turnId: 't1',
      }),
    ]);
    const handler = serveOpenUi(harness, {
      surface,
    });
    const stream = await handler(
      req('POST', {
        prompt: 'render',
      }),
    );
    const eventRes = await handler(
      req('POST', {
        event: {
          kind: 'submit',
          ref: 'form',
          seq: 5,
          clientId: 'tab-a',
        },
      }),
    );
    expect(eventRes.status).toBe(202);
    const body = EventEchoSchema.parse(await eventRes.json());
    expect(body.accepted).toBe(true);
    expect(body.seq).toBe(5);
    expect(typeof body.version).toBe('number');
    await drain(stream);
  });

  test('client disconnect (stream cancel) releases the prompt slot', async () => {
    const surface = await initSurface();
    // No turn_completed: the stream would pump forever without cancellation.
    const handler = serveOpenUi(makeFakeHarness([]), {
      surface,
    });
    const res = await handler(
      req('POST', {
        prompt: 'long turn',
      }),
    );
    expect(res.status).toBe(200);
    // Simulate the client going away.
    await res.body?.cancel();
    // The finished-hook must release the slot even though `done` never came.
    const retry = await handler(
      req('POST', {
        prompt: 'after disconnect',
      }),
    );
    expect(retry.status).toBe(200);
    await drain(retry);
  });

  test('a failed execute() releases the prompt slot instead of deadlocking the handler', async () => {
    const surface = await initSurface();
    const harness = makeFakeHarness([]);
    const failing = frameworkCast<AgentHarnessContract & FakeHarness>({
      ...harness,
      async execute() {
        throw new Error('execute blew up');
      },
    });
    const handler = serveOpenUi(failing, {
      surface,
    });
    await expect(
      handler(
        req('POST', {
          prompt: 'boom',
        }),
      ),
    ).rejects.toThrow('execute blew up');
    // Slot released — a retry reaches execute again (and fails again, not 409).
    await expect(
      handler(
        req('POST', {
          prompt: 'retry',
        }),
      ),
    ).rejects.toThrow('execute blew up');
  });
});
