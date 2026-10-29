/**
 * `createInMemoryConnection()` (spec 35 § The provider contract): the whole
 * provider contract as scripted functions, events and tasks, for tests. Given
 * `provision`, it also backs pools.
 *
 * It behaves as a conforming server would: `guarded` operations refuse with
 * `guarded` until the harness confirms them, `once` operations return their
 * original outcome for a repeated idempotency key and refuse the same key with
 * different arguments as `conflict`, and durable events replay from a cursor.
 */

import type {
  CallOptions,
  CallOutcome,
  CallResult,
  Connection,
  ConnectionErrorCode,
  ConnectionErrorPayload,
  ConnectionEventInfo,
  ConnectionEventInit,
  ConnectionIdentity,
  ConnectionInputRequest,
  ConnectionManifest,
  ConnectionOperationInfo,
  ConnectionProvider,
  ConnectionResourceInfo,
  ConnectionTaskState,
  ConnectionTaskStatus,
  ConnectOptions,
  Determinism,
  EventStream,
  EventStreamMessage,
  JsonSchemaObject,
  ListenRequest,
  SenseDescriptor,
} from '@noetic-tools/types';

//#region Types

/** What a scripted operation receives besides its arguments. */
export interface InMemoryCallContext {
  readonly idempotencyKey: string;
  readonly confirmed: boolean;
  readonly signal: AbortSignal;
  readonly connection: InMemoryConnection;
}

/** One step a scripted long operation reports before it finishes. */
export interface InMemoryTaskStep {
  readonly state: Exclude<ConnectionTaskState, 'completed' | 'failed' | 'cancelled'>;
  readonly message?: string;
  readonly progress?: ConnectionTaskStatus['progress'];
  /** For `input_required`: the question; the task waits for `respond`. */
  readonly request?: ConnectionInputRequest;
}

/** A scripted operation. */
export interface InMemoryOperation extends Omit<ConnectionOperationInfo, 'name' | 'inputSchema'> {
  /** Default `{ type: 'object' }`. */
  readonly inputSchema?: JsonSchemaObject;
  /**
   * Produces the output. Throw `inMemoryRefusal(code, message)` to refuse. For a
   * long operation, `answers` holds the replies to its questions by request id.
   */
  readonly run?: (
    args: unknown,
    context: InMemoryCallContext & {
      readonly answers: ReadonlyMap<string, unknown>;
    },
  ) => unknown;
  /** Makes it a long operation: these steps are reported, then `run` produces the outcome. */
  readonly task?: ReadonlyArray<InMemoryTaskStep>;
}

/** A scripted readable resource. */
export interface InMemoryResource extends Omit<ConnectionResourceInfo, 'name'> {
  readonly read: () => unknown;
}

/** A scripted event type. `replay` defaults to `'durable'`. */
export interface InMemoryEventType extends Omit<ConnectionEventInfo, 'name' | 'replay'> {
  readonly replay?: ConnectionEventInfo['replay'];
  /** Server-side filter: whether an event matches a listener's `arguments`. */
  readonly matches?: (args: Readonly<Record<string, unknown>>, payload: unknown) => boolean;
}

/** `createInMemoryConnection()` options. */
export interface InMemoryConnectionOptions {
  readonly id?: string;
  readonly surface?: string;
  /**
   * The identity instance (default: a fresh UUID per connection). A fixed one
   * stands for the same thing surviving a reconnect, as a server reporting the
   * same `noetic://identity` would.
   */
  readonly instance?: string;
  readonly epoch?: number;
  readonly profiles?: Readonly<Record<string, string>>;
  readonly extensions?: Readonly<Record<string, string>>;
  readonly senses?: Readonly<Record<string, SenseDescriptor>>;
  readonly determinism?: Determinism;
  readonly setup?: JsonSchemaObject;
  readonly operations?: Readonly<Record<string, InMemoryOperation>>;
  readonly resources?: Readonly<Record<string, InMemoryResource>>;
  readonly events?: Readonly<Record<string, InMemoryEventType>>;
  /** Supports `reset()`. */
  readonly reset?: () => void;
  /**
   * Makes the provider back a pool: called with each `setup`, returns the
   * options of the fresh connection (default: these options).
   */
  readonly provision?: (setup: Record<string, unknown>) => InMemoryConnectionOptions | undefined;
  /** Makes `connect()` fail with this message. */
  readonly failConnect?: string;
}

/** One call a scripted connection received. */
export interface InMemoryCallRecord {
  readonly op: string;
  readonly args: unknown;
  readonly options: CallOptions;
}

/** A scripted connection, with controls for driving it from a test. */
export interface InMemoryConnection extends Connection {
  readonly calls: ReadonlyArray<InMemoryCallRecord>;
  readonly released: boolean;
  /** The setup it was provisioned with (pools). */
  readonly setupGiven?: Readonly<Record<string, unknown>>;
  /** Delivers an event to every matching listener; returns it as delivered. */
  emit(
    type: string,
    payload: unknown,
    options?: {
      readonly id?: string;
      readonly actionId?: string;
    },
  ): ConnectionEventInit;
  /** Sends a gap to every listener of `type` (or all). */
  gap(reason: string, type?: string): void;
  /** Ends every listener's stream. */
  terminate(reason: string): void;
  /** Replaces the thing it drives: a new identity instance. */
  replace(): ConnectionIdentity;
  /** Changes the epoch only (a hot reload). */
  bumpEpoch(): ConnectionIdentity;
  /** Replaces its manifest parts and reports a manifest change. */
  updateManifest(
    patch: Partial<Omit<ConnectionManifest, 'operations'>> & {
      readonly operations?: Readonly<Record<string, InMemoryOperation>>;
    },
  ): void;
  /** Drops it, as a server crash would. */
  drop(reason: string): void;
}

/** The provider `createInMemoryConnection()` returns. */
export interface InMemoryConnectionProvider extends ConnectionProvider {
  /** The connection `connect()` returns (replaced when a reconnect follows a drop). */
  readonly connection: InMemoryConnection;
  /** Every connection `provision()` made. */
  readonly provisioned: ReadonlyArray<InMemoryConnection>;
  /** How many times `connect()` was called. */
  readonly connects: number;
}

/** One listener of a scripted or source event stream. */
export interface Listener {
  readonly event: string;
  readonly args: Readonly<Record<string, unknown>>;
  push(message: EventStreamMessage): void;
  end(): void;
}

interface TaskRecord {
  readonly op: string;
  readonly args: unknown;
  readonly steps: ReadonlyArray<InMemoryTaskStep>;
  readonly context: InMemoryCallContext;
  readonly answers: Map<string, unknown>;
  cancelled: boolean;
  readonly waiting: Map<string, () => void>;
}

//#endregion

//#region Helpers

/** An error a scripted operation throws to refuse, carrying the wire payload. */
export class InMemoryRefusal extends Error {
  readonly payload: ConnectionErrorPayload;

  constructor(payload: ConnectionErrorPayload) {
    super(payload.message);
    this.name = 'InMemoryRefusal';
    this.payload = payload;
  }
}

/** Builds an `InMemoryRefusal` for a scripted operation to throw. */
export function inMemoryRefusal(
  code: ConnectionErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): InMemoryRefusal {
  return new InMemoryRefusal({
    code,
    message,
    ...(details
      ? {
          details,
        }
      : {}),
  });
}

function errorResult(code: ConnectionErrorCode, message: string): CallOutcome {
  return {
    status: 'error',
    error: {
      code,
      message,
    },
  };
}

function operationInfos(
  operations: Readonly<Record<string, InMemoryOperation>>,
): Record<string, ConnectionOperationInfo> {
  const infos: Record<string, ConnectionOperationInfo> = {};
  for (const [name, op] of Object.entries(operations)) {
    const { run: _run, task: _task, inputSchema, ...rest } = op;
    infos[name] = {
      ...rest,
      name,
      inputSchema: inputSchema ?? {
        type: 'object',
      },
    };
  }
  return infos;
}

function resourceInfos(
  resources: Readonly<Record<string, InMemoryResource>>,
): Record<string, ConnectionResourceInfo> {
  const infos: Record<string, ConnectionResourceInfo> = {};
  for (const [name, resource] of Object.entries(resources)) {
    const { read: _read, ...rest } = resource;
    infos[name] = {
      ...rest,
      name,
    };
  }
  return infos;
}

function eventInfos(
  events: Readonly<Record<string, InMemoryEventType>>,
): Record<string, ConnectionEventInfo> {
  const infos: Record<string, ConnectionEventInfo> = {};
  for (const [name, event] of Object.entries(events)) {
    const { matches: _matches, ...rest } = event;
    infos[name] = {
      ...rest,
      name,
      replay: event.replay ?? 'durable',
    };
  }
  return infos;
}

function buildManifest(options: InMemoryConnectionOptions): ConnectionManifest {
  return {
    profiles: options.profiles ?? {},
    extensions: options.extensions ?? {},
    operations: operationInfos(options.operations ?? {}),
    resources: resourceInfos(options.resources ?? {}),
    events: eventInfos(options.events ?? {}),
    senses: options.senses ?? {},
    ...(options.determinism
      ? {
          determinism: options.determinism,
        }
      : {}),
    ...(options.setup
      ? {
          setup: options.setup,
        }
      : {}),
  };
}

/** A listener-backed event stream: messages pushed to `listener` are iterated from `stream`. */
export function createListenerStream(
  listeners: Set<Listener>,
  request: ListenRequest,
  ready: {
    cursor: string | null;
  },
): {
  readonly stream: EventStream;
  readonly listener: Listener;
} {
  const queue: EventStreamMessage[] = [];
  const waiters: Array<(result: IteratorResult<EventStreamMessage>) => void> = [];
  let ended = false;
  const finish = (): void => {
    ended = true;
    listeners.delete(listener);
    for (const waiter of waiters.splice(0)) {
      waiter({
        value: undefined,
        done: true,
      });
    }
  };
  const listener: Listener = {
    event: request.event,
    args: request.arguments ?? {},
    push(message): void {
      if (ended) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({
          value: message,
          done: false,
        });
        return;
      }
      queue.push(message);
    },
    end: finish,
  };
  request.signal.addEventListener('abort', finish, {
    once: true,
  });
  const stream: EventStream = {
    ready: Promise.resolve(ready),
    close: async (): Promise<void> => finish(),
    [Symbol.asyncIterator](): AsyncIterator<EventStreamMessage> {
      return {
        next(): Promise<IteratorResult<EventStreamMessage>> {
          const message = queue.shift();
          if (message) {
            return Promise.resolve({
              value: message,
              done: false,
            });
          }
          if (ended) {
            return Promise.resolve({
              value: undefined,
              done: true,
            });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        async return(): Promise<IteratorResult<EventStreamMessage>> {
          finish();
          return {
            value: undefined,
            done: true,
          };
        },
      };
    },
  };
  return {
    stream,
    listener,
  };
}

//#endregion

//#region Connection

function createConnection(
  options: InMemoryConnectionOptions,
  setupGiven?: Readonly<Record<string, unknown>>,
): InMemoryConnection {
  let operations: Readonly<Record<string, InMemoryOperation>> = options.operations ?? {};
  let manifest = buildManifest(options);
  let identity: ConnectionIdentity = {
    surface: options.surface ?? 'x-memory',
    instance: options.instance ?? crypto.randomUUID(),
    ...(options.epoch !== undefined
      ? {
          epoch: options.epoch,
        }
      : {}),
  };
  const calls: InMemoryCallRecord[] = [];
  const listeners = new Set<Listener>();
  const changeListeners = new Set<(change: 'manifest' | 'identity') => void>();
  const history: ConnectionEventInit[] = [];
  const onceResults = new Map<
    string,
    {
      readonly args: string;
      readonly result: CallResult;
    }
  >();
  const tasks = new Map<string, TaskRecord>();
  let sequence = 0;
  let released = false;
  let resolveClosed: (value: { reason: string }) => void = () => undefined;
  const closed = new Promise<{
    reason: string;
  }>((resolve) => {
    resolveClosed = resolve;
  });

  const notify = (change: 'manifest' | 'identity'): void => {
    for (const listener of [
      ...changeListeners,
    ]) {
      listener(change);
    }
  };

  const runOperation = async (
    op: InMemoryOperation,
    args: unknown,
    context: InMemoryCallContext & {
      readonly answers: ReadonlyMap<string, unknown>;
    },
  ): Promise<CallOutcome> => {
    try {
      const output = await op.run?.(args, context);
      return {
        status: 'ok',
        output: output ?? null,
      };
    } catch (e) {
      if (e instanceof InMemoryRefusal) {
        return {
          status: 'error',
          error: e.payload,
        };
      }
      throw e;
    }
  };

  const connection: InMemoryConnection = {
    id: options.id ?? 'memory',
    get manifest(): ConnectionManifest {
      return manifest;
    },
    get identity(): ConnectionIdentity {
      return identity;
    },
    calls,
    get released(): boolean {
      return released;
    },
    setupGiven,

    async call(opName, args, callOptions): Promise<CallResult> {
      calls.push({
        op: opName,
        args,
        options: callOptions,
      });
      const op = operations[opName];
      if (!op) {
        return errorResult('undeclared', `'${opName}' is not an operation of this connection`);
      }
      if (op.guarded && !callOptions.confirmed) {
        return errorResult('guarded', `'${opName}' needs confirmation`);
      }
      const argsKey = JSON.stringify(args);
      const previous = op.once ? onceResults.get(callOptions.idempotencyKey) : undefined;
      if (previous) {
        return previous.args === argsKey
          ? previous.result
          : errorResult('conflict', 'idempotency key reused with different arguments');
      }
      const context: InMemoryCallContext = {
        idempotencyKey: callOptions.idempotencyKey,
        confirmed: callOptions.confirmed === true,
        signal: callOptions.signal,
        connection,
      };
      if (op.task) {
        const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;
        tasks.set(taskId, {
          op: opName,
          args,
          steps: op.task,
          context,
          answers: new Map(),
          cancelled: false,
          waiting: new Map(),
        });
        return {
          status: 'task',
          taskId,
        };
      }
      const result = await runOperation(op, args, {
        ...context,
        answers: new Map(),
      });
      if (op.once) {
        onceResults.set(callOptions.idempotencyKey, {
          args: argsKey,
          result,
        });
      }
      return result;
    },

    async read(resource): Promise<unknown> {
      const found = options.resources?.[resource];
      if (!found) {
        throw inMemoryRefusal('not_found', `no resource '${resource}'`);
      }
      return found.read();
    },

    listen(request): EventStream {
      const latest = history[history.length - 1]?.cursor ?? null;
      const { stream, listener } = createListenerStream(listeners, request, {
        cursor: latest,
      });
      if (request.cursor !== undefined && request.cursor !== null) {
        const after = Number(request.cursor);
        for (const event of history) {
          if (event.type === request.event && Number(event.cursor) > after) {
            listener.push({
              type: 'event',
              event,
            });
          }
        }
      }
      listeners.add(listener);
      return stream;
    },

    tasks: {
      async get(taskId): Promise<ConnectionTaskStatus> {
        const task = tasks.get(taskId);
        return {
          taskId,
          state: task?.cancelled ? 'cancelled' : 'working',
        };
      },
      async result(taskId, resultOptions): Promise<CallOutcome> {
        const task = tasks.get(taskId);
        if (!task) {
          return errorResult('not_found', `no task '${taskId}'`);
        }
        for (const step of task.steps) {
          if (resultOptions.signal.aborted || task.cancelled) {
            throw new Error('task wait aborted');
          }
          resultOptions.onProgress?.({
            taskId,
            ...step,
          });
          const question = step.request;
          if (step.state !== 'input_required' || !question) {
            continue;
          }
          await new Promise<void>((resolve, reject) => {
            task.waiting.set(question.id, resolve);
            resultOptions.signal.addEventListener(
              'abort',
              () => reject(new Error('task wait aborted')),
              {
                once: true,
              },
            );
          });
        }
        const op = operations[task.op];
        if (!op) {
          return errorResult('undeclared', `'${task.op}' is gone`);
        }
        const outcome = await runOperation(op, task.args, {
          ...task.context,
          answers: task.answers,
        });
        resultOptions.onProgress?.({
          taskId,
          state: outcome.status === 'ok' ? 'completed' : 'failed',
        });
        return outcome;
      },
      async cancel(taskId): Promise<void> {
        const task = tasks.get(taskId);
        if (task) {
          task.cancelled = true;
        }
      },
      async respond(taskId, requestId, answer): Promise<void> {
        const task = tasks.get(taskId);
        if (!task) {
          return;
        }
        task.answers.set(requestId, answer);
        task.waiting.get(requestId)?.();
      },
    },

    ...(options.reset
      ? {
          async reset(): Promise<void> {
            options.reset?.();
          },
        }
      : {}),

    onChange(listener): () => void {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },

    closed,

    async release(): Promise<void> {
      released = true;
      for (const listener of [
        ...listeners,
      ]) {
        listener.end();
      }
      resolveClosed({
        reason: 'released',
      });
    },

    emit(type, payload, emitOptions): ConnectionEventInit {
      sequence += 1;
      const event: ConnectionEventInit = {
        id: emitOptions?.id ?? `evt-${sequence}`,
        type,
        time: new Date().toISOString(),
        payload,
        cursor: String(sequence),
        ...(emitOptions?.actionId
          ? {
              actionId: emitOptions.actionId,
            }
          : {}),
      };
      history.push(event);
      const matches = options.events?.[type]?.matches;
      for (const listener of [
        ...listeners,
      ]) {
        if (listener.event !== type) {
          continue;
        }
        if (matches && !matches(listener.args, payload)) {
          continue;
        }
        listener.push({
          type: 'event',
          event,
        });
      }
      return event;
    },

    gap(reason, type): void {
      for (const listener of [
        ...listeners,
      ]) {
        if (type === undefined || listener.event === type) {
          listener.push({
            type: 'gap',
            reason,
          });
        }
      }
    },

    terminate(reason): void {
      for (const listener of [
        ...listeners,
      ]) {
        listener.push({
          type: 'terminated',
          reason,
        });
        listener.end();
      }
    },

    replace(): ConnectionIdentity {
      identity = {
        ...identity,
        instance: crypto.randomUUID(),
      };
      notify('identity');
      return identity;
    },

    bumpEpoch(): ConnectionIdentity {
      identity = {
        ...identity,
        epoch: (identity.epoch ?? 0) + 1,
      };
      notify('identity');
      return identity;
    },

    updateManifest(patch): void {
      if (patch.operations) {
        operations = patch.operations;
      }
      manifest = {
        ...manifest,
        ...patch,
        operations: operationInfos(operations),
      };
      notify('manifest');
    },

    drop(reason): void {
      for (const listener of [
        ...listeners,
      ]) {
        listener.push({
          type: 'terminated',
          reason,
        });
        listener.end();
      }
      resolveClosed({
        reason,
      });
    },
  };
  return connection;
}

//#endregion

//#region Public API

/**
 * @public
 * A scripted `ConnectionProvider` for tests: operations, reads, events and
 * long operations as plain functions. With `provision`, it backs pools.
 */
export function createInMemoryConnection(
  options: InMemoryConnectionOptions = {},
): InMemoryConnectionProvider {
  let current = createConnection(options);
  let connects = 0;
  const provisioned: InMemoryConnection[] = [];
  const provider: InMemoryConnectionProvider = {
    get connection(): InMemoryConnection {
      return current;
    },
    get provisioned(): ReadonlyArray<InMemoryConnection> {
      return provisioned;
    },
    get connects(): number {
      return connects;
    },
    async connect(_opts: ConnectOptions): Promise<ReadonlyArray<Connection>> {
      connects += 1;
      if (options.failConnect) {
        throw new Error(options.failConnect);
      }
      if (connects > 1) {
        current = createConnection(options);
      }
      return [
        current,
      ];
    },
    ...(options.provision
      ? {
          async provision(setup: Record<string, unknown>): Promise<Connection> {
            const fresh = createConnection(options.provision?.(setup) ?? options, setup);
            provisioned.push(fresh);
            return fresh;
          },
        }
      : {}),
  };
  return provider;
}

//#endregion
