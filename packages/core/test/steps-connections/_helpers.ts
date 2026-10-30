/**
 * A scripted connection registry for connection-step tests. It implements the
 * registry contract steps code against (`connections/registry-types.ts`) and
 * records everything steps ask of it.
 */

import type {
  ConnectionEvent,
  ConnectionIdentity,
  ConnectionManifest,
  Context,
  Determinism,
  EventStream,
  EventStreamMessage,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, NoeticErrorImpl } from '@noetic-tools/types';
import type { ResumeDecision } from '../../src/connections/durability';
import { resumeDecision } from '../../src/connections/durability';
import type {
  ConnectionRegistry,
  GatedCallOptions,
  ResolvedConnection,
  ResolveRequest,
} from '../../src/connections/registry-types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { setHarnessInternals } from '../../src/util/harness-internals';

//#region Types

export type OpHandler = (args: unknown, opts: GatedCallOptions) => unknown;

export interface FakeConnectionConfig {
  ops?: Record<string, OpHandler>;
  determinism?: Determinism;
  identity?: ConnectionIdentity;
  /** Called by `reset`. */
  onReset?: () => void;
}

export interface RecordedCall {
  connection: string;
  op: string;
  args: unknown;
  opts: GatedCallOptions;
}

export interface RecordedListen {
  connection: string;
  event: string;
  cursor: string | null | undefined;
}

//#endregion

//#region Event queue

/** A push-fed event stream: `push` delivers to the iterator in order. */
class QueueStream implements EventStream<ConnectionEvent> {
  readonly ready: Promise<{
    cursor: string | null;
  }>;
  private readonly buffer: EventStreamMessage<ConnectionEvent>[] = [];
  private waiter:
    | ((value: IteratorResult<EventStreamMessage<ConnectionEvent>>) => void)
    | undefined;
  private closed = false;

  constructor(
    cursor: string | null,
    private readonly onClose: () => void,
  ) {
    this.ready = Promise.resolve({
      cursor,
    });
  }

  push(message: EventStreamMessage<ConnectionEvent>): void {
    if (this.closed) {
      return;
    }
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({
        done: false,
        value: message,
      });
      return;
    }
    this.buffer.push(message);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onClose();
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({
        done: true,
        value: undefined,
      });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<EventStreamMessage<ConnectionEvent>> {
    return {
      next: () => {
        const next = this.buffer.shift();
        if (next) {
          return Promise.resolve({
            done: false,
            value: next,
          });
        }
        if (this.closed) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

//#endregion

//#region Registry

const EMPTY_MANIFEST: ConnectionManifest = {
  profiles: {},
  extensions: {},
  operations: {},
  resources: {},
  events: {},
  senses: {},
};

/** A registry whose connections run scripted operation handlers and pushed events. */
export class FakeRegistry implements ConnectionRegistry {
  readonly resolves: ResolveRequest[] = [];
  readonly calls: RecordedCall[] = [];
  readonly listens: RecordedListen[] = [];
  readonly resets: string[] = [];
  /** Task ids a resumed call waited on instead of sending again. */
  readonly awaited: string[] = [];
  private readonly streams = new Map<string, Set<QueueStream>>();
  private eventCount = 0;

  constructor(private readonly connections: Record<string, FakeConnectionConfig>) {}

  names(): ReadonlyArray<string> {
    return Object.keys(this.connections);
  }

  async resolve(request: ResolveRequest): Promise<ResolvedConnection> {
    this.resolves.push(request);
    const name = request.from ?? request.name;
    const config = this.connections[name];
    if (!config) {
      throw new NoeticConfigError({
        code: 'CONNECTION_UNKNOWN',
        message: `No connection '${name}'.`,
        hint: 'Add it to the fake registry.',
      });
    }
    return this.resolvedFor(request.name, config);
  }

  async releaseScope(): Promise<void> {}
  async releaseRun(): Promise<void> {}

  /** Names `harness.restore(id, { rerun })` let run live again. */
  readonly reruns = new Set<string>();

  rerunAllowed(_executionId: string, name: string): boolean {
    return this.reruns.has(name);
  }

  /** The registry's run-level resume check, against the scripted identity and determinism. */
  async checkResume(params: {
    readonly executionId: string;
    readonly name: string;
    readonly recorded: ConnectionIdentity;
  }): Promise<ResumeDecision> {
    const config = this.connections[params.name];
    const current = config?.identity ?? {
      surface: 'fake',
      instance: `${params.name}-1`,
    };
    const decision = resumeDecision({
      recorded: params.recorded,
      current,
      determinism: config?.determinism,
      rerunAllowed: this.reruns.has(params.name),
      canReset: config?.onReset !== undefined,
    });
    if (decision === 'refuse') {
      throw new NoeticErrorImpl({
        kind: 'connection_resume_refused',
        connection: params.name,
        reason: 'replaced',
      });
    }
    if (decision === 'reset') {
      this.resets.push(params.name);
      config?.onReset?.();
    }
    return decision;
  }

  status(): ReadonlyArray<never> {
    return [];
  }

  /** Delivers an event to every listener on `connection`. */
  emit(connection: string, type: string, payload: unknown): ConnectionEvent {
    this.eventCount += 1;
    const event: ConnectionEvent = {
      id: `e${this.eventCount}`,
      type,
      time: new Date(0).toISOString(),
      payload,
      cursor: `c${this.eventCount}`,
      connection,
    };
    this.push(connection, {
      type: 'event',
      event,
    });
    return event;
  }

  /** Delivers a control message (`gap`, `terminated`) to every listener on `connection`. */
  push(connection: string, message: EventStreamMessage<ConnectionEvent>): void {
    for (const stream of this.streams.get(connection) ?? []) {
      stream.push(message);
    }
  }

  listenerCount(connection: string): number {
    return this.streams.get(connection)?.size ?? 0;
  }

  private resolvedFor(name: string, config: FakeConnectionConfig): ResolvedConnection {
    const manifest: ConnectionManifest = config.determinism
      ? {
          ...EMPTY_MANIFEST,
          determinism: config.determinism,
        }
      : EMPTY_MANIFEST;
    const resolved: ResolvedConnection = {
      name,
      manifest,
      identity: () =>
        config.identity ?? {
          surface: 'fake',
          instance: `${name}-1`,
        },
      call: async (op, args, opts) => {
        this.calls.push({
          connection: name,
          op,
          args,
          opts,
        });
        const handler = config.ops?.[op];
        return handler ? await handler(args, opts) : null;
      },
      awaitTask: async (taskId) => {
        this.awaited.push(taskId);
        return {
          resumedTask: taskId,
        };
      },
      read: async () => null,
      listen: (req) => {
        this.listens.push({
          connection: name,
          event: req.event,
          cursor: req.cursor,
        });
        const set = this.streams.get(name) ?? new Set<QueueStream>();
        this.streams.set(name, set);
        const stream = new QueueStream(req.cursor ?? 'c0', () => set.delete(stream));
        set.add(stream);
        return stream;
      },
      ...(config.onReset
        ? {
            reset: async () => {
              this.resets.push(name);
              config.onReset?.();
            },
          }
        : {}),
    };
    return resolved;
  }
}

//#endregion

//#region Harness

/** A harness whose connection registry is `registry`, installed the way the harness exposes it to steps. */
export function harnessWith(
  registry: ConnectionRegistry | undefined,
  name = 'connection-test',
): AgentHarness {
  const harness = new AgentHarness({
    name,
    params: {},
  });
  if (registry) {
    setHarnessInternals(harness, {
      connectionRegistry: registry,
    });
  }
  return harness;
}

//#endregion

//#region Framework events

/** A framework event as the broadcaster receives it. */
export interface CapturedEvent {
  type: string;
  data: Record<string, unknown>;
}

/** A root context of `harness` whose framework events land in the returned list. */
export function capturingContext(harness: AgentHarness): {
  ctx: Context;
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  const ctx = harness.createContext();
  frameworkCast<{
    _broadcaster: unknown;
  }>(ctx)._broadcaster = {
    emit(event: CapturedEvent) {
      events.push(event);
    },
  };
  return {
    ctx,
    events,
  };
}

//#endregion
