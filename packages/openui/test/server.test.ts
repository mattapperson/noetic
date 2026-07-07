import { describe, expect, test } from 'bun:test';
import type { AgentHarnessContract, Item, StreamEvent } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
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

  test('maps completion and error; ignores unrelated events', () => {
    expect(translateStreamEvent(sdk('response.completed'), AGENT)).toEqual({
      type: 'done',
    });
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
    expect(translateStreamEvent(framework('llm_call_started'), AGENT)).toBeNull();
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
      framework('openui.node', {
        ref: 'root',
        kind: 'component',
        source: 'root = Card("Hi")',
      }),
      sdk('response.completed'),
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
