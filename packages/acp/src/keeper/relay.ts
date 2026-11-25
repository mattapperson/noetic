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
 * - Follows the agent's subagents: a child session announced on a session it
 *   knows (`subagent_update`, or codex-acp's draft `subagent_spawned`) belongs
 *   to that session's root, so the child's updates and requests — and a
 *   grandchild's — are delivered, held, journaled and asked again exactly as
 *   the root's own, each line unchanged.
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

/** One of the agent's requests still waiting on an answer. */
interface Pending {
  readonly line: string;
  /** The session it names: the root's own, or one of its descendants'. */
  readonly sessionId?: string;
  /** The attachment it was last sent to. */
  askedEpoch?: number;
}

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
  /**
   * The agent's requests still waiting on an answer, by the agent's id: the
   * session's own and its descendants'.
   */
  pending: Map<Id, Pending>;
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

/** Descendant sessions remembered, beyond which the oldest with nothing pending go. */
const MAX_DESCENDANTS = 1e3;

/** Sessions with updates held before the relay can place them. */
const MAX_PROVISIONAL_SESSIONS = 64;

/** Updates held per session the relay cannot place yet, beyond which the oldest go. */
const MAX_PROVISIONAL_UPDATES = 256;

/** Where each announcement names the child session it announces. */
const CHILD_SESSION_KEYS: Readonly<Record<string, string>> = {
  subagent_update: 'sessionId',
  subagent_spawned: 'subagentSessionId',
};

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

function updateOf(params: unknown): Json | undefined {
  return isRecord(params) && isRecord(params.update) ? params.update : undefined;
}

/** The child session a `session/update` announces, if it announces one. */
function announcedChild(params: unknown): string | undefined {
  const update = updateOf(params);
  const kind = update?.sessionUpdate;
  const key = typeof kind === 'string' ? CHILD_SESSION_KEYS[kind] : undefined;
  const child = update && key ? update[key] : undefined;
  return typeof child === 'string' ? child : undefined;
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
  /**
   * The agent's requests that name no session, or a session the relay cannot
   * place: every attachment is asked, so none waits on a host forever.
   */
  private readonly unscoped = new Map<Id, Pending>();
  /** Each descendant session, by id, to the root session it belongs to. */
  private readonly owners = new Map<string, string>();
  /**
   * The latest line that announced each descendant, kept in the order the
   * descendants were first announced (a parent before its children), to tell
   * a fresh host of them.
   */
  private readonly announcements = new Map<string, string>();
  /** Each descendant's immediate parent session. */
  private readonly parents = new Map<string, string>();
  /** Updates for sessions not placed yet, held until one is announced. */
  private readonly provisional = new Map<string, string[]>();
  private initialized?: unknown;

  constructor(private readonly send: RelaySenders) {}

  /** A host attached. */
  attach(): void {
    this.attached = true;
    for (const pending of this.unscoped.values()) {
      this.ask(pending);
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
      this.claim(sessionId, session, false);
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
    if (sessionId) {
      this.adopt(sessionId);
    }
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
    this.claim(sessionId, session, true);
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
  private claim(sessionId: string | undefined, session: SessionState, replayTurn: boolean): void {
    if (session.claimedBy === this.epoch) {
      return;
    }
    session.claimedBy = this.epoch;
    const missed = replayTurn ? session.journal : session.backlog;
    // A host that never saw the root's children announced — they were started
    // by an earlier turn — is told of them first, so it can place their
    // traffic. Parents come before the children they announced.
    // Every one, even if the journal repeats it: a journal entry may come
    // after a grandchild's, and a parent must be placed first.
    for (const announcement of this.ancestryOf(sessionId)) {
      this.send.toHost(announcement);
    }
    for (const update of missed) {
      this.send.toHost(update);
    }
    session.backlog = [];
    for (const pending of session.pending.values()) {
      if (pending.askedEpoch !== this.epoch) {
        this.ask(pending);
      }
    }
  }

  /** Send one of the agent's requests to the attached host. */
  private ask(pending: Pending): void {
    pending.askedEpoch = this.epoch;
    this.send.toHost(pending.line);
  }

  private forget(agentId: Id): void {
    if (this.unscoped.delete(agentId)) {
      return;
    }
    for (const session of this.sessions.values()) {
      if (session.pending.delete(agentId)) {
        // A child kept past the cap only while waited on can go now.
        this.trimOwners();
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
    const sessionId = this.remember(asked, answer);
    this.answered(asked, answer);
    if (sessionId) {
      // A session it now knows: what the agent sent for it before is placed.
      this.adopt(sessionId);
    }
  }

  private answered(asked: Asked, answer: Answer): void {
    if (asked.method === 'session/prompt') {
      this.turnEnded(asked, answer);
      return;
    }
    if (this.isLive(asked.epoch)) {
      this.answerHost(asked.hostId, answer);
    }
  }

  /** Keep what an answer says about the agent and its sessions; the session it names. */
  private remember(asked: Asked, answer: Answer): string | undefined {
    if (!('result' in answer) || !isRecord(answer.result)) {
      return undefined;
    }
    const result = answer.result;
    if (asked.method === 'initialize') {
      this.initialized = result;
      return undefined;
    }
    const sessionId =
      asked.method === 'session/new' ? sessionIdOf(result) : sessionIdOf(asked.params);
    if (!sessionId) {
      return undefined;
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
    return sessionId;
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
    const rootId = sessionId ? this.rootOf(sessionId) : undefined;
    if (rootId === undefined) {
      // No session, or one not placed yet: ask whoever is attached.
      const pending: Pending = {
        line: raw,
        sessionId,
      };
      this.unscoped.set(agentId, pending);
      if (this.attached) {
        this.ask(pending);
      }
      return;
    }
    const session = this.session(rootId);
    const pending: Pending = {
      line: raw,
      sessionId,
    };
    session.pending.set(agentId, pending);
    if (this.holds(session)) {
      this.ask(pending);
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
    const rootId = this.rootOf(sessionId);
    if (rootId === undefined) {
      this.hold(sessionId, raw);
      return;
    }
    const session = this.session(rootId);
    if (rootId === sessionId) {
      this.track(session, params);
    }
    this.deliver(session, raw);
    const child = announcedChild(params);
    if (child) {
      this.adoptChild(child, sessionId, rootId, raw);
    }
  }

  /** An update for a session's root: live to its holder, else kept. */
  private deliver(session: SessionState, raw: string): void {
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
    const update = updateOf(params);
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

  //#region Subagents

  /** A child session, announced under `rootId`'s tree, now belongs to that root. */
  private adoptChild(child: string, parent: string, rootId: string, announcement: string): void {
    if (child === rootId || this.sessions.has(child)) {
      return;
    }
    // Re-set so a re-announced child counts as the newest.
    this.owners.delete(child);
    this.owners.set(child, rootId);
    this.parents.set(child, parent);
    // `set` on a known key keeps its place: first-announced order, latest line.
    this.announcements.set(child, announcement);
    // Its waiting requests become its root's before anything is trimmed, so
    // a child with a request pending is never the one forgotten.
    this.adoptRequests(child, this.session(rootId));
    this.trimOwners();
    this.adopt(child);
  }

  /**
   * The announcements of `rootId`'s descendants, each the first that named it,
   * in the order they were first announced: a parent before its children.
   */
  private ancestryOf(rootId: string | undefined): string[] {
    if (rootId === undefined) {
      return [];
    }
    const lines: string[] = [];
    for (const [child, announcement] of this.announcements) {
      if (this.owners.get(child) === rootId) {
        lines.push(announcement);
      }
    }
    return lines;
  }

  /**
   * Forget the descendants heard from least recently past the cap, never one
   * with a request pending.
   */
  private trimOwners(): void {
    for (const [child, rootId] of this.owners) {
      if (this.owners.size <= MAX_DESCENDANTS) {
        return;
      }
      if (!this.isWaitedOn(child, rootId) && !this.isParentOfKept(child)) {
        this.owners.delete(child);
        this.announcements.delete(child);
        this.parents.delete(child);
      }
    }
  }

  /** Whether a descendant still kept was announced under `child`: its chain must stay. */
  private isParentOfKept(child: string): boolean {
    for (const [kept, parent] of this.parents) {
      if (parent === child && this.owners.has(kept)) {
        return true;
      }
    }
    return false;
  }

  private isWaitedOn(child: string, rootId: string): boolean {
    const session = this.sessions.get(rootId);
    if (!session) {
      return false;
    }
    for (const pending of session.pending.values()) {
      if (pending.sessionId === child) {
        return true;
      }
    }
    return false;
  }

  /**
   * A session the relay can now place: its requests asked so far of every
   * attachment become its root's, and the updates held for it are taken as
   * if they arrived now (an announcement among them places a grandchild).
   */
  private adopt(sessionId: string): void {
    const rootId = this.rootOf(sessionId);
    if (rootId === undefined) {
      return;
    }
    this.adoptRequests(sessionId, this.session(rootId));
    const held = this.provisional.get(sessionId);
    if (!held) {
      return;
    }
    this.provisional.delete(sessionId);
    for (const raw of held) {
      this.fromAgent(raw);
    }
  }

  private adoptRequests(sessionId: string, root: SessionState): void {
    for (const [agentId, pending] of this.unscoped) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      this.unscoped.delete(agentId);
      root.pending.set(agentId, pending);
    }
  }

  /** Hold an update for a session the relay cannot place yet. */
  private hold(sessionId: string, raw: string): void {
    let held = this.provisional.get(sessionId);
    if (!held) {
      held = [];
      this.provisional.set(sessionId, held);
      this.trimProvisional();
    }
    held.push(raw);
    if (held.length > MAX_PROVISIONAL_UPDATES) {
      held.shift();
    }
  }

  private trimProvisional(): void {
    for (const sessionId of this.provisional.keys()) {
      if (this.provisional.size <= MAX_PROVISIONAL_SESSIONS) {
        return;
      }
      this.provisional.delete(sessionId);
    }
  }

  //#endregion

  //#region State

  /** The root session a session belongs to: its owner, itself, or none known. */
  private rootOf(sessionId: string): string | undefined {
    const owner = this.owners.get(sessionId);
    if (owner !== undefined) {
      // A child still heard from is never the oldest to forget — the same
      // order a host's connection keeps, so both forget the same children.
      this.owners.delete(sessionId);
      this.owners.set(sessionId, owner);
      return owner;
    }
    return this.sessions.has(sessionId) ? sessionId : undefined;
  }

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
