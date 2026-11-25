/**
 * The ACP relay inside an agent's keeper: it sits between the agent's stdio
 * and whichever host is attached, so the agent can outlive a host and a later
 * host can take it over.
 *
 * Pure: it consumes JSON-RPC lines from each side and emits lines through the
 * two senders it is given. The keeper process (`main.ts`) owns the I/O.
 *
 * What it does:
 * - Rewrites every host request id to its own, so a response is routed to the
 *   host attachment that asked; a later host's ids never collide with
 *   requests an earlier host left in flight.
 * - Answers `initialize` from its cache after the first, so a reattaching host
 *   negotiates without re-initializing the agent.
 * - Keeps, per session, the modes and config options the agent advertised,
 *   the updates of the turn in flight, updates sent while no host held the
 *   session, the agent's unanswered requests, and a turn result no host was
 *   attached to receive.
 * - Serves two keeper requests a reattaching host makes:
 *   `_noetic/keeper/session` (what it knows of a session) and
 *   `_noetic/keeper/turn` (hand the session to this host: send the turn's
 *   updates and the agent's waiting requests again, then the turn's result
 *   once there is one).
 */

//#region Types

/** A JSON-RPC id. */
type Id = string | number;

type Json = Record<string, unknown>;

/** Where a host request's response goes. */
interface Asked {
  /** The attachment that asked; a response for an earlier one has no host. */
  readonly epoch: number;
  readonly hostId: Id;
  readonly method: string;
  readonly params: Json;
}

/** The outcome of a `session/prompt`, as the agent answered it. */
type Answer =
  | {
      result: unknown;
    }
  | {
      error: unknown;
    };

interface SessionState {
  modes?: unknown;
  configOptions?: unknown;
  /** The attachment that holds the session; others get nothing live. */
  claimedBy: number;
  /** The keeper id of the `session/prompt` in flight. */
  turn?: number;
  /** Every update since the turn in flight (or the last unclaimed one) began. */
  journal: string[];
  /** Updates sent while no attachment held the session and no turn ran. */
  backlog: string[];
  /** The last turn's answer, when no host was there to take it. */
  finished?: Answer;
  /** A reattached host waiting for the turn in flight. */
  waiter?: {
    epoch: number;
    hostId: Id;
  };
  /** The agent's requests still waiting on an answer, by the agent's id. */
  pending: Map<Id, string>;
}

/** What {@link AcpRelay} sends. */
export interface RelaySenders {
  toHost(line: string): void;
  toAgent(line: string): void;
}

/** The answer to `_noetic/keeper/session`. */
export interface KeeperSessionInfo {
  known: boolean;
  modes?: unknown;
  configOptions?: unknown;
  turn: 'running' | 'finished' | 'idle';
}

//#endregion

//#region Constants

/** @public The keeper's own requests, which never reach the agent. */
export const KEEPER_METHODS = {
  session: '_noetic/keeper/session',
  turn: '_noetic/keeper/turn',
} as const;

/** Updates kept per session while no host holds it, beyond which the oldest go. */
const MAX_BACKLOG = 1e4;

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is Id {
  return typeof value === 'string' || typeof value === 'number';
}

function parse(line: string): Json | undefined {
  try {
    const value = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sessionIdOf(params: unknown): string | undefined {
  return isRecord(params) && typeof params.sessionId === 'string' ? params.sessionId : undefined;
}

function line(message: Json): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    ...message,
  });
}

//#endregion

//#region Relay

/** @public See the module comment. */
export class AcpRelay {
  /** Bumped on every detach, so what an earlier attachment asked has no host. */
  private epoch = 0;
  private attached = false;
  private nextId = 1;
  private readonly asked = new Map<number, Asked>();
  private readonly sessions = new Map<string, SessionState>();
  /** The agent's requests that name no session. */
  private readonly unscoped = new Map<Id, string>();
  private initialized?: unknown;

  constructor(private readonly send: RelaySenders) {}

  /** A host attached. */
  attach(): void {
    this.attached = true;
    for (const pending of this.unscoped.values()) {
      this.send.toHost(pending);
    }
  }

  /** The host went away; everything it held is kept for the next one. */
  detach(): void {
    this.attached = false;
    this.epoch += 1;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  //#region From the host

  fromHost(raw: string): void {
    const message = parse(raw);
    if (!message) {
      return;
    }
    const method = typeof message.method === 'string' ? message.method : undefined;
    const id = isId(message.id) ? message.id : undefined;
    if (method !== undefined && id !== undefined) {
      this.hostRequest(method, id, isRecord(message.params) ? message.params : {}, message);
      return;
    }
    if (method === undefined && id !== undefined) {
      // The host's answer to one of the agent's requests.
      this.forget(id);
      this.send.toAgent(raw);
      return;
    }
    this.send.toAgent(raw);
  }

  private hostRequest(method: string, hostId: Id, params: Json, message: Json): void {
    if (method === KEEPER_METHODS.session) {
      this.answerHost(hostId, {
        result: this.sessionInfo(sessionIdOf(params)),
      });
      return;
    }
    if (method === KEEPER_METHODS.turn) {
      this.resumeTurn(sessionIdOf(params), hostId);
      return;
    }
    if (method === 'initialize' && this.initialized !== undefined) {
      this.answerHost(hostId, {
        result: this.initialized,
      });
      return;
    }
    const keeperId = this.nextId;
    this.nextId += 1;
    this.asked.set(keeperId, {
      epoch: this.epoch,
      hostId,
      method,
      params,
    });
    const sessionId = sessionIdOf(params);
    if (sessionId && (method === 'session/prompt' || method === 'session/load')) {
      const session = this.session(sessionId);
      this.claim(session, false);
      if (method === 'session/prompt') {
        session.turn = keeperId;
        session.finished = undefined;
        session.journal = [];
      }
    }
    this.send.toAgent(
      JSON.stringify({
        ...message,
        id: keeperId,
      }),
    );
  }

  private sessionInfo(sessionId: string | undefined): KeeperSessionInfo {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      return {
        known: false,
        turn: 'idle',
      };
    }
    return {
      known: true,
      modes: session.modes,
      configOptions: session.configOptions,
      turn: session.turn !== undefined ? 'running' : session.finished ? 'finished' : 'idle',
    };
  }

  /**
   * Hand a session to this host: its turn's updates and the agent's waiting
   * requests again, then the turn's result — now, or when the agent answers.
   */
  private resumeTurn(sessionId: string | undefined, hostId: Id): void {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      this.answerHost(hostId, {
        error: {
          code: -32602,
          message: `The keeper has no session ${String(sessionId)}.`,
        },
      });
      return;
    }
    this.claim(session, true);
    if (session.finished) {
      const finished = session.finished;
      session.finished = undefined;
      this.answerHost(hostId, turnAnswer(finished));
      return;
    }
    if (session.turn === undefined) {
      this.answerHost(hostId, {
        result: {
          state: 'idle',
        },
      });
      return;
    }
    session.waiter = {
      epoch: this.epoch,
      hostId,
    };
  }

  /**
   * The current attachment takes the session: what it missed (the whole turn
   * when resuming one, else the backlog) and the agent's waiting requests.
   */
  private claim(session: SessionState, replayTurn: boolean): void {
    if (session.claimedBy === this.epoch) {
      return;
    }
    session.claimedBy = this.epoch;
    const missed = replayTurn ? session.journal : session.backlog;
    for (const update of missed) {
      this.send.toHost(update);
    }
    session.backlog = [];
    for (const pending of session.pending.values()) {
      this.send.toHost(pending);
    }
  }

  private forget(agentId: Id): void {
    if (this.unscoped.delete(agentId)) {
      return;
    }
    for (const session of this.sessions.values()) {
      if (session.pending.delete(agentId)) {
        return;
      }
    }
  }

  private answerHost(hostId: Id, answer: Answer): void {
    this.send.toHost(
      line({
        id: hostId,
        ...answer,
      }),
    );
  }

  //#endregion

  //#region From the agent

  fromAgent(raw: string): void {
    const message = parse(raw);
    if (!message) {
      return;
    }
    const method = typeof message.method === 'string' ? message.method : undefined;
    const id = isId(message.id) ? message.id : undefined;
    if (method === undefined && typeof id === 'number') {
      this.agentResponse(id, message);
      return;
    }
    if (method !== undefined && id !== undefined) {
      this.agentRequest(id, message.params, raw);
      return;
    }
    if (method !== undefined) {
      this.agentNotification(method, message.params, raw);
    }
  }

  private agentResponse(keeperId: number, message: Json): void {
    const asked = this.asked.get(keeperId);
    if (!asked) {
      return;
    }
    this.asked.delete(keeperId);
    const answer: Answer =
      'error' in message
        ? {
            error: message.error,
          }
        : {
            result: message.result,
          };
    this.remember(asked, answer);
    if (asked.method === 'session/prompt') {
      this.turnEnded(asked, answer);
      return;
    }
    if (this.isLive(asked.epoch)) {
      this.answerHost(asked.hostId, answer);
    }
  }

  /** Keep what an answer says about the agent and its sessions. */
  private remember(asked: Asked, answer: Answer): void {
    if (!('result' in answer) || !isRecord(answer.result)) {
      return;
    }
    const result = answer.result;
    if (asked.method === 'initialize') {
      this.initialized = result;
      return;
    }
    const sessionId =
      asked.method === 'session/new' ? sessionIdOf(result) : sessionIdOf(asked.params);
    if (!sessionId) {
      return;
    }
    const session = this.session(sessionId);
    if (asked.method === 'session/new') {
      session.claimedBy = asked.epoch;
    }
    if ('modes' in result && result.modes !== null) {
      session.modes = result.modes;
    }
    if ('configOptions' in result && result.configOptions !== null) {
      session.configOptions = result.configOptions;
    }
    if (asked.method === 'session/set_mode' && isRecord(session.modes)) {
      session.modes = {
        ...session.modes,
        currentModeId: asked.params.modeId,
      };
    }
  }

  private turnEnded(asked: Asked, answer: Answer): void {
    const sessionId = sessionIdOf(asked.params);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session) {
      session.turn = undefined;
    }
    if (this.isLive(asked.epoch)) {
      this.answerHost(asked.hostId, answer);
      return;
    }
    const waiter = session?.waiter;
    if (session && waiter && this.isLive(waiter.epoch)) {
      session.waiter = undefined;
      this.answerHost(waiter.hostId, turnAnswer(answer));
      return;
    }
    if (session) {
      session.finished = answer;
    }
  }

  private agentRequest(agentId: Id, params: unknown, raw: string): void {
    const sessionId = sessionIdOf(params);
    if (!sessionId) {
      this.unscoped.set(agentId, raw);
      if (this.attached) {
        this.send.toHost(raw);
      }
      return;
    }
    const session = this.session(sessionId);
    session.pending.set(agentId, raw);
    if (this.holds(session)) {
      this.send.toHost(raw);
    }
  }

  private agentNotification(method: string, params: unknown, raw: string): void {
    const sessionId = sessionIdOf(params);
    if (method !== 'session/update' || !sessionId) {
      if (this.attached) {
        this.send.toHost(raw);
      }
      return;
    }
    const session = this.session(sessionId);
    this.track(session, params);
    if (session.turn !== undefined) {
      session.journal.push(raw);
    }
    if (this.holds(session)) {
      this.send.toHost(raw);
      return;
    }
    if (session.turn === undefined) {
      session.backlog.push(raw);
      if (session.backlog.length > MAX_BACKLOG) {
        session.backlog.shift();
      }
    }
  }

  /** Follow the mode and config option updates a session reports. */
  private track(session: SessionState, params: unknown): void {
    const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
    if (!update) {
      return;
    }
    if (update.sessionUpdate === 'current_mode_update' && isRecord(session.modes)) {
      session.modes = {
        ...session.modes,
        currentModeId: update.currentModeId,
      };
    }
    if (update.sessionUpdate === 'config_option_update') {
      session.configOptions = update.configOptions;
    }
  }

  //#endregion

  //#region State

  private session(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        claimedBy: -1,
        journal: [],
        backlog: [],
        pending: new Map(),
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** Whether the attached host holds the session, so it gets it live. */
  private holds(session: SessionState): boolean {
    return this.attached && session.claimedBy === this.epoch;
  }

  private isLive(epoch: number): boolean {
    return this.attached && epoch === this.epoch;
  }

  //#endregion
}

/** A finished turn, as `_noetic/keeper/turn` answers it. */
function turnAnswer(answer: Answer): Answer {
  if ('error' in answer) {
    return answer;
  }
  return {
    result: {
      state: 'finished',
      response: answer.result,
    },
  };
}

//#endregion
