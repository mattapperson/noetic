import type {
  BlobRef,
  ConnectionEvent,
  ConnectionEventInfo,
  ConnectionIdentity,
  ConnectionManifest,
  ConnectionOperationInfo,
  ConnectionResourceInfo,
  EventStream,
  EventStreamMessage,
  SenseDescriptor,
  SenseId,
} from '@noetic-tools/types';
import type {
  Anomaly,
  BlindSpot,
  VerificationRun,
  VerifyActResult,
  VerifyConnection,
  VerifyHost,
  VerifyParticipant,
} from '@noetic-tools/types/verify';

//#region Fake connection

/** A pushable event stream. */
export interface FakeStream extends EventStream<ConnectionEvent> {
  push(message: EventStreamMessage<ConnectionEvent>): void;
  readonly closed: boolean;
}

function fakeStream(startCursor: string | null = null): FakeStream {
  const queue: EventStreamMessage<ConnectionEvent>[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const stream: FakeStream = {
    ready: Promise.resolve({
      cursor: startCursor,
    }),
    get closed() {
      return closed;
    },
    push(message) {
      queue.push(message);
      wake?.();
    },
    async close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
  return stream;
}

export interface FakeConnectionInit {
  name: string;
  senses: Record<string, SenseDescriptor>;
  events?: Record<
    string,
    {
      sense?: SenseId;
    }
  >;
  resources?: Record<
    string,
    {
      sense: SenseId;
      values: unknown[];
    }
  >;
  operations?: Record<string, Partial<ConnectionOperationInfo>>;
  identity?: ConnectionIdentity;
  onCall?: (op: string, args: unknown) => unknown;
  coverage?: BlindSpot[];
  anomalies?: Anomaly[];
  listenFails?: string[];
  /** The cursor each stream reports it starts from (default null). */
  startCursor?: string;
}

/** An in-memory `VerifyConnection` whose events tests push and whose reads return queued values. */
export interface FakeConnection extends VerifyConnection {
  emit(type: string, payload: unknown): void;
  gap(event: string, reason: string): void;
  terminate(event: string, reason: string): void;
  setIdentity(identity: ConnectionIdentity): void;
  readonly calls: Array<{
    op: string;
    args: unknown;
  }>;
  readonly reads: string[];
  /** The `since` each coverage and detect request carried. */
  readonly since: Array<string | null>;
  participant(role: 'subject' | 'witness'): VerifyParticipant;
}

export function fakeConnection(init: FakeConnectionInit): FakeConnection {
  const streams = new Map<string, FakeStream[]>();
  let identity: ConnectionIdentity = init.identity ?? {
    surface: 'web',
    instance: `${init.name}-1`,
  };
  const readIndex = new Map<string, number>();
  const calls: FakeConnection['calls'] = [];
  const reads: string[] = [];
  const since: Array<string | null> = [];
  let seq = 0;
  const events: Record<string, ConnectionEventInfo> = {};
  for (const [name, info] of Object.entries(init.events ?? {})) {
    events[name] = {
      name,
      replay: 'live',
      ...(info.sense === undefined
        ? {}
        : {
            sense: info.sense,
          }),
    };
  }
  const resources: Record<string, ConnectionResourceInfo> = {};
  for (const [name, info] of Object.entries(init.resources ?? {})) {
    resources[name] = {
      name,
      sense: info.sense,
    };
  }
  const operations: Record<string, ConnectionOperationInfo> = {};
  for (const [name, info] of Object.entries(init.operations ?? {})) {
    operations[name] = {
      name,
      inputSchema: {
        type: 'object',
      },
      ...info,
    };
  }
  const manifest: ConnectionManifest = {
    profiles: {},
    extensions: {},
    operations,
    resources,
    events,
    senses: init.senses,
  };
  const pushTo = (event: string, message: EventStreamMessage<ConnectionEvent>): void => {
    for (const s of streams.get(event) ?? []) {
      s.push(message);
    }
  };
  const conn: FakeConnection = {
    name: init.name,
    manifest,
    calls,
    reads,
    since,
    identity: () => identity,
    setIdentity(next) {
      identity = next;
    },
    async call(op, args) {
      calls.push({
        op,
        args,
      });
      return init.onCall?.(op, args);
    },
    async read(resource) {
      reads.push(resource);
      const spec = init.resources?.[resource];
      if (!spec) {
        throw new Error(`no resource ${resource}`);
      }
      const i = readIndex.get(resource) ?? 0;
      readIndex.set(resource, i + 1);
      const value = spec.values[Math.min(i, spec.values.length - 1)];
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
    listen(req) {
      if (init.listenFails?.includes(req.event)) {
        throw new Error(`cannot listen to ${req.event}`);
      }
      const stream = fakeStream(init.startCursor ?? null);
      streams.set(req.event, [
        ...(streams.get(req.event) ?? []),
        stream,
      ]);
      return stream;
    },
    emit(type, payload) {
      seq += 1;
      pushTo(type, {
        type: 'event',
        event: {
          id: `e${seq}`,
          type,
          time: new Date().toISOString(),
          payload,
          cursor: String(seq),
          connection: init.name,
        },
      });
    },
    gap(event, reason) {
      pushTo(event, {
        type: 'gap',
        reason,
      });
    },
    terminate(event, reason) {
      pushTo(event, {
        type: 'terminated',
        reason,
      });
    },
    participant(role) {
      return {
        name: init.name,
        role,
        identity,
        manifest,
        senses: init.senses,
      };
    },
    ...(init.coverage === undefined
      ? {}
      : {
          coverage: async (from: string | null) => {
            since.push(from);
            return init.coverage ?? [];
          },
        }),
    ...(init.anomalies === undefined
      ? {}
      : {
          detect: async (from: string | null) => {
            since.push(from);
            return init.anomalies ?? [];
          },
        }),
  };
  return conn;
}

//#endregion

//#region Fake host

/** What a test's act does: nothing, or report pending tasks and touched connections. */
export type FakeAct =
  | (() => void)
  | (() => Partial<VerifyActResult>)
  | (() => Promise<Partial<VerifyActResult>>);

export interface FakeHost extends VerifyHost {
  readonly recorded: VerificationRun[];
}

export function fakeHost(opts: {
  subject: VerifyConnection;
  witnesses?: VerifyConnection[];
  act?: FakeAct;
  signal?: AbortSignal;
}): FakeHost {
  const recorded: VerificationRun[] = [];
  const witnesses: Record<string, VerifyConnection> = {};
  for (const w of opts.witnesses ?? []) {
    witnesses[w.name] = w;
  }
  return {
    signal: opts.signal ?? new AbortController().signal,
    now: () => Date.now(),
    subject: opts.subject,
    witnesses,
    recorded,
    async act() {
      try {
        const result: Partial<VerifyActResult> = (await opts.act?.()) ?? {};
        return {
          pendingTasks: [],
          touched: [],
          ...result,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error : new Error(String(error)),
          pendingTasks: [],
          touched: [],
        };
      }
    },
    async record(run): Promise<BlobRef> {
      recorded.push(run);
      return {
        $blob: {
          uri: `artifact://sha256/${'0'.repeat(64)}`,
          mimeType: 'application/json',
          bytes: JSON.stringify(run).length,
          sha256: '0'.repeat(64),
        },
      };
    },
  };
}

//#endregion

//#region Senses

export const NET: SenseDescriptor = {
  independence: 'independent',
  grade: 'consequence',
};
export const UI: SenseDescriptor = {
  independence: 'actuation-derived',
  grade: 'presence',
};
export const LOG: SenseDescriptor = {
  independence: 'independent',
  grade: 'context',
};
export const STATE: SenseDescriptor = {
  independence: 'actuation-derived',
  grade: 'consequence',
};
export const TIME: SenseDescriptor = {
  independence: 'independent',
  grade: 'context',
};
export const WITNESS_DB: SenseDescriptor = {
  independence: 'independent',
  grade: 'consequence',
};

/** A browser-like subject: net, ui, log, state and time, with request, console and render events. */
export function browserSubject(extra?: Partial<FakeConnectionInit>): FakeConnection {
  return fakeConnection({
    name: 'app',
    senses: {
      net: NET,
      ui: UI,
      log: LOG,
      state: STATE,
      time: TIME,
    },
    events: {
      'browser.request': {
        sense: 'net',
      },
      'browser.console.message': {
        sense: 'log',
      },
      'ui.changed': {
        sense: 'ui',
      },
      'browser.signal': {
        sense: 'signal',
      },
      'app.done': {},
    },
    ...extra,
  });
}

/** Error code of a thrown NoeticConfigError, or undefined. */
export function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

//#endregion
