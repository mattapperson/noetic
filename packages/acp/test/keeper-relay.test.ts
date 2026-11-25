import { describe, expect, it } from 'bun:test';
import { AcpRelay, KEEPER_METHODS } from '../src/keeper/relay';

type Message = Record<string, unknown>;

function rig() {
  const toHost: Message[] = [];
  const toAgent: Message[] = [];
  const relay = new AcpRelay({
    toHost: (line) => toHost.push(JSON.parse(line)),
    toAgent: (line) => toAgent.push(JSON.parse(line)),
  });
  relay.attach();
  const host = (message: Message) => relay.fromHost(JSON.stringify(message));
  const agent = (message: Message) => relay.fromAgent(JSON.stringify(message));
  return {
    relay,
    toHost,
    toAgent,
    host,
    agent,
  };
}

function update(sessionId: string, text: string): Message {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text,
        },
      },
    },
  };
}

/** Open session `s1` through the relay as a host does. */
function openSession(r: ReturnType<typeof rig>): void {
  r.host({
    jsonrpc: '2.0',
    id: 0,
    method: 'session/new',
    params: {
      cwd: '/',
    },
  });
  const forwarded = r.toAgent.at(-1);
  r.agent({
    jsonrpc: '2.0',
    id: forwarded?.id,
    result: {
      sessionId: 's1',
      modes: {
        currentModeId: 'auto',
        availableModes: [],
      },
    },
  });
}

describe('AcpRelay', () => {
  it('rewrites request ids both ways', () => {
    const r = rig();
    r.host({
      jsonrpc: '2.0',
      id: 'a',
      method: 'session/new',
      params: {},
    });
    const forwarded = r.toAgent[0];
    expect(forwarded?.id).not.toBe('a');
    r.agent({
      jsonrpc: '2.0',
      id: forwarded?.id,
      result: {
        sessionId: 's1',
      },
    });
    expect(r.toHost[0]).toMatchObject({
      id: 'a',
      result: {
        sessionId: 's1',
      },
    });
  });

  it('answers a second initialize from its cache', () => {
    const r = rig();
    r.host({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    r.agent({
      jsonrpc: '2.0',
      id: r.toAgent[0]?.id,
      result: {
        protocolVersion: 1,
      },
    });
    r.relay.detach();
    r.relay.attach();
    r.host({
      jsonrpc: '2.0',
      id: 7,
      method: 'initialize',
      params: {},
    });
    expect(r.toAgent).toHaveLength(1);
    expect(r.toHost.at(-1)).toMatchObject({
      id: 7,
      result: {
        protocolVersion: 1,
      },
    });
  });

  it('drops a response meant for a host that went away', () => {
    const r = rig();
    r.host({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/set_mode',
      params: {
        sessionId: 's1',
        modeId: 'x',
      },
    });
    r.relay.detach();
    r.relay.attach();
    r.agent({
      jsonrpc: '2.0',
      id: r.toAgent[0]?.id,
      result: {},
    });
    expect(r.toHost).toEqual([]);
  });

  it('reports what it knows of a session, and tracks mode and config updates', () => {
    const r = rig();
    openSession(r);
    r.agent({
      ...update('s1', 'x'),
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'plan',
        },
      },
    });
    r.agent({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [
            {
              id: 'model',
            },
          ],
        },
      },
    });
    r.host({
      jsonrpc: '2.0',
      id: 'q',
      method: KEEPER_METHODS.session,
      params: {
        sessionId: 's1',
      },
    });
    expect(r.toHost.at(-1)).toMatchObject({
      id: 'q',
      result: {
        known: true,
        modes: {
          currentModeId: 'plan',
        },
        configOptions: [
          {
            id: 'model',
          },
        ],
        turn: 'idle',
      },
    });
    r.host({
      jsonrpc: '2.0',
      id: 'u',
      method: KEEPER_METHODS.session,
      params: {
        sessionId: 'nope',
      },
    });
    expect(r.toHost.at(-1)).toMatchObject({
      result: {
        known: false,
      },
    });
  });

  it('holds updates and requests while detached and hands the whole turn to the next host', () => {
    const r = rig();
    openSession(r);
    r.host({
      jsonrpc: '2.0',
      id: 'p',
      method: 'session/prompt',
      params: {
        sessionId: 's1',
        prompt: [],
      },
    });
    const prompt = r.toAgent.at(-1);
    r.agent(update('s1', 'one '));
    expect(r.toHost.at(-1)).toMatchObject(update('s1', 'one '));
    r.relay.detach();
    r.agent(update('s1', 'two'));
    r.agent({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
      },
    });
    const sentBefore = r.toHost.length;
    r.relay.attach();
    // Nothing for the session until a host claims it.
    expect(r.toHost.length).toBe(sentBefore);
    r.host({
      jsonrpc: '2.0',
      id: 't',
      method: KEEPER_METHODS.turn,
      params: {
        sessionId: 's1',
      },
    });
    const handed = r.toHost.slice(sentBefore);
    expect(handed).toEqual([
      update('s1', 'one '),
      update('s1', 'two'),
      {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/request_permission',
        params: {
          sessionId: 's1',
        },
      },
    ]);
    // The host answers the request; the agent gets it.
    r.host({
      jsonrpc: '2.0',
      id: 99,
      result: {
        outcome: {
          outcome: 'cancelled',
        },
      },
    });
    expect(r.toAgent.at(-1)).toMatchObject({
      id: 99,
    });
    // The turn ends: the waiting host gets it as the keeper's answer.
    r.agent({
      jsonrpc: '2.0',
      id: prompt?.id,
      result: {
        stopReason: 'end_turn',
      },
    });
    expect(r.toHost.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 't',
      result: {
        state: 'finished',
        response: {
          stopReason: 'end_turn',
        },
      },
    });
  });

  it('keeps a turn that ended with no host, and passes on its error', () => {
    const r = rig();
    openSession(r);
    r.host({
      jsonrpc: '2.0',
      id: 'p',
      method: 'session/prompt',
      params: {
        sessionId: 's1',
        prompt: [],
      },
    });
    const prompt = r.toAgent.at(-1);
    r.relay.detach();
    r.agent({
      jsonrpc: '2.0',
      id: prompt?.id,
      error: {
        code: -32000,
        message: 'Authentication required',
      },
    });
    r.relay.attach();
    r.host({
      jsonrpc: '2.0',
      id: 'i',
      method: KEEPER_METHODS.session,
      params: {
        sessionId: 's1',
      },
    });
    expect(r.toHost.at(-1)).toMatchObject({
      result: {
        turn: 'finished',
      },
    });
    r.host({
      jsonrpc: '2.0',
      id: 't',
      method: KEEPER_METHODS.turn,
      params: {
        sessionId: 's1',
      },
    });
    expect(r.toHost.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 't',
      error: {
        code: -32000,
        message: 'Authentication required',
      },
    });
    // Taken once: the next ask finds no turn.
    r.host({
      jsonrpc: '2.0',
      id: 't2',
      method: KEEPER_METHODS.turn,
      params: {
        sessionId: 's1',
      },
    });
    expect(r.toHost.at(-1)).toMatchObject({
      id: 't2',
      result: {
        state: 'idle',
      },
    });
  });

  it('refuses a turn for a session it does not know', () => {
    const r = rig();
    r.host({
      jsonrpc: '2.0',
      id: 't',
      method: KEEPER_METHODS.turn,
      params: {
        sessionId: 'nope',
      },
    });
    expect(r.toHost.at(-1)).toMatchObject({
      id: 't',
      error: {
        code: -32602,
      },
    });
  });

  it('sends the backlog when a later host prompts, and unscoped requests on attach', () => {
    const r = rig();
    openSession(r);
    r.relay.detach();
    r.agent(update('s1', 'between turns'));
    r.agent({
      jsonrpc: '2.0',
      id: 5,
      method: 'fs/read_text_file',
      params: {},
    });
    r.agent({
      jsonrpc: '2.0',
      method: 'x/notice',
      params: {},
    });
    const before = r.toHost.length;
    r.relay.attach();
    expect(r.toHost.slice(before)).toEqual([
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'fs/read_text_file',
        params: {},
      },
    ]);
    r.host({
      jsonrpc: '2.0',
      id: 5,
      result: {},
    });
    r.host({
      jsonrpc: '2.0',
      id: 'p2',
      method: 'session/prompt',
      params: {
        sessionId: 's1',
        prompt: [],
      },
    });
    expect(r.toHost.at(-1)).toMatchObject(update('s1', 'between turns'));
  });

  it('ignores lines that are not JSON objects and passes host notifications on', () => {
    const r = rig();
    r.relay.fromHost('not json');
    r.relay.fromAgent('[1,2]');
    r.host({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: {
        sessionId: 's1',
      },
    });
    expect(r.toAgent).toEqual([
      {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: {
          sessionId: 's1',
        },
      },
    ]);
    expect(r.toHost).toEqual([]);
    expect(r.relay.isAttached).toBe(true);
  });
});
