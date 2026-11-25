import { describe, expect, it } from 'bun:test';
import { AcpRelay, KEEPER_METHODS } from '../src/keeper/relay';

type Message = Record<string, unknown>;

interface Rig {
  relay: AcpRelay;
  toHost: Message[];
  toAgent: Message[];
  host(message: Message): void;
  agent(message: Message): void;
}

function rig(): Rig {
  const toHost: Message[] = [];
  const toAgent: Message[] = [];
  const relay = new AcpRelay({
    toHost: (line) => toHost.push(JSON.parse(line)),
    toAgent: (line) => toAgent.push(JSON.parse(line)),
  });
  relay.attach();
  return {
    relay,
    toHost,
    toAgent,
    host: (message) => relay.fromHost(JSON.stringify(message)),
    agent: (message) => relay.fromAgent(JSON.stringify(message)),
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

/** The subagents RFD's announcement of `child` on `parent`. */
function announce(parent: string, child: string): Message {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: parent,
      update: {
        sessionUpdate: 'subagent_update',
        sessionId: child,
        status: 'running',
      },
    },
  };
}

/** codex-acp's earlier draft announcement. */
function announceDraft(parent: string, child: string): Message {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: parent,
      update: {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: child,
      },
    },
  };
}

function request(id: number, method: string, sessionId: string): Message {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      sessionId,
    },
  };
}

/** Open session `s1` and start a turn on it; the keeper id of the prompt. */
function openTurn(r: Rig): unknown {
  r.host({
    jsonrpc: '2.0',
    id: 0,
    method: 'session/new',
    params: {
      cwd: '/',
    },
  });
  r.agent({
    jsonrpc: '2.0',
    id: r.toAgent.at(-1)?.id,
    result: {
      sessionId: 's1',
    },
  });
  r.host({
    jsonrpc: '2.0',
    id: 'p',
    method: 'session/prompt',
    params: {
      sessionId: 's1',
      prompt: [],
    },
  });
  return r.toAgent.at(-1)?.id;
}

/** Detach, reattach, and resume `s1`'s turn; what the new host was sent. */
function reattachAndResume(r: Rig): Message[] {
  r.relay.attach();
  const before = r.toHost.length;
  r.host({
    jsonrpc: '2.0',
    id: 't',
    method: KEEPER_METHODS.turn,
    params: {
      sessionId: 's1',
    },
  });
  return r.toHost.slice(before);
}

describe('AcpRelay subagents', () => {
  it("tells a fresh host of a child an earlier turn started, before that child's traffic", () => {
    const r = rig();
    const first = openTurn(r);
    r.agent(announce('s1', 'c1'));
    r.agent(update('c1', 'first turn'));
    r.agent({
      jsonrpc: '2.0',
      id: first,
      result: {
        stopReason: 'end_turn',
      },
    });
    // A second prompt: its journal starts empty, but the child is reused.
    r.host({
      jsonrpc: '2.0',
      id: 'p2',
      method: 'session/prompt',
      params: {
        sessionId: 's1',
        prompt: [],
      },
    });
    r.relay.detach();
    r.agent(update('c1', 'second turn'));
    expect(reattachAndResume(r)).toEqual([
      announce('s1', 'c1'),
      update('c1', 'second turn'),
    ]);
  });

  it('keeps the whole chain of a grandchild that is waited on, and replays it parents first', () => {
    const r = rig();
    const first = openTurn(r);
    r.agent(announce('s1', 'p'));
    r.agent(announce('p', 'g'));
    r.agent(request(77, 'session/request_permission', 'g'));
    r.agent({
      jsonrpc: '2.0',
      id: first,
      result: {
        stopReason: 'end_turn',
      },
    });
    for (let i = 0; i < 1000; i += 1) {
      r.agent(announce('s1', `sib${i}`));
    }
    r.relay.detach();
    const handed = reattachAndResume(r);
    const announced = handed
      .map((message) => JSON.stringify(message))
      .filter((line) => line.includes('subagent_update'));
    const parentAt = announced.findIndex((line) => line.includes('"sessionId":"p"'));
    const grandAt = announced.findIndex((line) => line.includes('"sessionId":"g"'));
    expect(parentAt).toBeGreaterThanOrEqual(0);
    expect(grandAt).toBeGreaterThan(parentAt);
    expect(handed).toContainEqual(request(77, 'session/request_permission', 'g'));
  });

  it('never forgets a child whose request is pending, and trims it once answered', () => {
    const r = rig();
    openTurn(r);
    r.agent(request(90, 'elicitation/create', 'early'));
    r.agent(announce('s1', 'early'));
    for (let i = 0; i < 1001; i += 1) {
      r.agent(announce('s1', `c${i}`));
    }
    // Still placed: its later updates reach the host, not a provisional buffer.
    r.agent(update('early', 'still here'));
    expect(r.toHost.at(-1)).toEqual(update('early', 'still here'));
  });

  it('delivers a child session live while its root is held', () => {
    const r = rig();
    openTurn(r);
    r.agent(announce('s1', 'c1'));
    r.agent(update('c1', 'child'));
    expect(r.toHost.slice(-2)).toEqual([
      announce('s1', 'c1'),
      update('c1', 'child'),
    ]);
  });

  it('journals a child with its root while detached and replays them in order', () => {
    const r = rig();
    const prompt = openTurn(r);
    r.agent(update('s1', 'a'));
    r.agent(announce('s1', 'c1'));
    r.relay.detach();
    r.agent(update('c1', 'b'));
    r.agent(update('s1', 'c'));
    r.agent(update('c1', 'd'));
    expect(reattachAndResume(r)).toEqual([
      announce('s1', 'c1'),
      update('s1', 'a'),
      announce('s1', 'c1'),
      update('c1', 'b'),
      update('s1', 'c'),
      update('c1', 'd'),
    ]);
    // Live again for the host that took the turn.
    r.agent(update('c1', 'e'));
    expect(r.toHost.at(-1)).toEqual(update('c1', 'e'));
    r.agent({
      jsonrpc: '2.0',
      id: prompt,
      result: {
        stopReason: 'end_turn',
      },
    });
    expect(r.toHost.at(-1)).toMatchObject({
      id: 't',
      result: {
        state: 'finished',
      },
    });
  });

  it("asks a child's waiting requests again on reattach and routes the answers back", () => {
    const r = rig();
    openTurn(r);
    r.agent(announce('s1', 'c1'));
    r.relay.detach();
    r.agent(request(40, 'elicitation/create', 'c1'));
    r.agent(request(41, 'session/request_permission', 'c1'));
    const sent = r.toHost.length;
    r.relay.attach();
    // Nothing for the tree until a host claims its root.
    expect(r.toHost.length).toBe(sent);
    const handed = reattachAndResume(r);
    expect(handed.slice(-2)).toEqual([
      request(40, 'elicitation/create', 'c1'),
      request(41, 'session/request_permission', 'c1'),
    ]);
    r.host({
      jsonrpc: '2.0',
      id: 40,
      result: {
        action: 'decline',
      },
    });
    r.host({
      jsonrpc: '2.0',
      id: 41,
      result: {
        outcome: {
          outcome: 'cancelled',
        },
      },
    });
    expect(r.toAgent.slice(-2)).toEqual([
      {
        jsonrpc: '2.0',
        id: 40,
        result: {
          action: 'decline',
        },
      },
      {
        jsonrpc: '2.0',
        id: 41,
        result: {
          outcome: {
            outcome: 'cancelled',
          },
        },
      },
    ]);
    // Answered: a later host is not asked again.
    r.relay.detach();
    expect(reattachAndResume(r).filter((message) => 'id' in message && message.id !== 't')).toEqual(
      [],
    );
  });

  it('places a grandchild announced on a child under the same root', () => {
    const r = rig();
    openTurn(r);
    r.agent(announce('s1', 'c1'));
    r.relay.detach();
    r.agent(announce('c1', 'g1'));
    r.agent(update('g1', 'deep'));
    r.agent(request(50, 'fs/read_text_file', 'g1'));
    // The chain first, parents before children, then the turn as it happened.
    expect(reattachAndResume(r)).toEqual([
      announce('s1', 'c1'),
      announce('c1', 'g1'),
      announce('s1', 'c1'),
      announce('c1', 'g1'),
      update('g1', 'deep'),
      request(50, 'fs/read_text_file', 'g1'),
    ]);
  });

  it("follows codex-acp's draft subagent_spawned announcement", () => {
    const r = rig();
    openTurn(r);
    r.agent(announceDraft('s1', 'c1'));
    r.relay.detach();
    r.agent(update('c1', 'drafted'));
    expect(reattachAndResume(r)).toEqual([
      announceDraft('s1', 'c1'),
      announceDraft('s1', 'c1'),
      update('c1', 'drafted'),
    ]);
  });

  it('holds a child update sent before its announcement and places it after', () => {
    const r = rig();
    openTurn(r);
    r.agent(update('c1', 'early'));
    expect(r.toHost.some((message) => JSON.stringify(message).includes('early'))).toBe(false);
    r.agent(announce('s1', 'c1'));
    expect(r.toHost.slice(-2)).toEqual([
      announce('s1', 'c1'),
      update('c1', 'early'),
    ]);
  });

  it('holds an update sent before session/new answers and delivers it after the answer', () => {
    const r = rig();
    r.host({
      jsonrpc: '2.0',
      id: 0,
      method: 'session/new',
      params: {
        cwd: '/',
      },
    });
    const asked = r.toAgent.at(-1)?.id;
    r.agent(update('s1', 'commands'));
    expect(r.toHost).toEqual([]);
    r.agent({
      jsonrpc: '2.0',
      id: asked,
      result: {
        sessionId: 's1',
      },
    });
    expect(r.toHost).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        result: {
          sessionId: 's1',
        },
      },
      update('s1', 'commands'),
    ]);
  });

  it('asks a request from a session never announced of every attachment, never twice', () => {
    const r = rig();
    openTurn(r);
    r.agent(request(60, 'session/request_permission', 'stranger'));
    expect(r.toHost.at(-1)).toEqual(request(60, 'session/request_permission', 'stranger'));
    r.relay.detach();
    const before = r.toHost.length;
    r.relay.attach();
    expect(r.toHost.slice(before)).toEqual([
      request(60, 'session/request_permission', 'stranger'),
    ]);
    // Announced later: it is the root's now, already asked of this host.
    r.agent(announce('s1', 'stranger'));
    const handed = reattachAndResume(r);
    expect(handed.filter((message) => message.id === 60)).toEqual([]);
    r.host({
      jsonrpc: '2.0',
      id: 60,
      result: {},
    });
    expect(r.toAgent.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 60,
      result: {},
    });
  });

  it('asks a request from an unplaced session of a host attached after it arrived', () => {
    const r = rig();
    openTurn(r);
    r.relay.detach();
    r.agent(request(61, 'elicitation/create', 'stranger'));
    r.agent(announce('s1', 'stranger'));
    // Placed while no host was attached: the turn's next host is asked.
    const handed = reattachAndResume(r);
    expect(handed.filter((message) => message.id === 61)).toEqual([
      request(61, 'elicitation/create', 'stranger'),
    ]);
  });

  it('keeps the provisional buffer and the descendant map bounded', () => {
    const r = rig();
    openTurn(r);
    // 300 updates for one unplaced session: only the newest 256 survive.
    for (let index = 0; index < 300; index += 1) {
      r.agent(update('c0', `u${index}`));
    }
    // 64 more unplaced sessions push the oldest (c0) out entirely.
    for (let index = 1; index <= 64; index += 1) {
      r.agent(update(`c${index}`, 'x'));
    }
    r.agent(announce('s1', 'c0'));
    expect(r.toHost.at(-1)).toEqual(announce('s1', 'c0'));
    r.agent(announce('s1', 'c64'));
    expect(r.toHost.at(-1)).toEqual(update('c64', 'x'));

    // A child waited on survives 1e3 newer siblings; one not waited on does not.
    const fresh = rig();
    openTurn(fresh);
    fresh.agent(announce('s1', 'waiting'));
    fresh.agent(request(70, 'session/request_permission', 'waiting'));
    fresh.agent(announce('s1', 'idle'));
    for (let index = 0; index < 1e3; index += 1) {
      fresh.agent(announce('s1', `n${index}`));
    }
    fresh.agent(update('waiting', 'still placed'));
    expect(fresh.toHost.at(-1)).toEqual(update('waiting', 'still placed'));
    fresh.agent(update('idle', 'forgotten'));
    expect(fresh.toHost.at(-1)).not.toEqual(update('idle', 'forgotten'));
  });

  it("keeps a child's config options off its root's session info", () => {
    const r = rig();
    openTurn(r);
    r.agent(announce('s1', 'c1'));
    r.agent({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'c1',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [
            {
              id: 'child-only',
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
    const info = r.toHost.at(-1);
    expect(info).toMatchObject({
      id: 'q',
      result: {
        known: true,
      },
    });
    expect(JSON.stringify(info)).not.toContain('child-only');
  });
});
