/**
 * The connection contract (spec 35): the values that cross a connection
 * (refs, blobs, secrets, receipts), the provider contract an MCP bridge or a
 * source implements, the harness configuration for connections and triggers,
 * and the framework events connections emit.
 *
 * `@noetic-tools/core` receives providers, profiles and a verifier from the
 * caller and resolves connections through this contract; it never imports
 * `@noetic-tools/mcp`, a profile package or `@noetic-tools/verify`.
 */

import { z } from 'zod';
import { NoeticConfigError } from '../errors/noetic-config-error';
import type { ArtifactStore } from './artifact-store';
import type {
  AnyExtension,
  AnyProfile,
  Determinism,
  ExtensionRange,
  LookMode,
  ProfileRange,
  ReplayMode,
  SenseDescriptor,
  SenseId,
} from './profile';

//#region Constants

/** @public `_meta` key carrying a call's idempotency key (spec 35 § Durability). */
export const IDEMPOTENCY_KEY_META = 'tools.noetic/idempotency-key';

/** @public `_meta` key only the harness sets, confirming a `guarded` operation was approved (spec 36 § Errors). */
export const CONFIRMED_META = 'tools.noetic/confirmed';

/** @public `_meta` key naming the instance a request targets when one server serves several connections (spec 36). */
export const INSTANCE_META = 'tools.noetic/instance';

/** @public The MCP `extensions` capability key a server declares its profiles under (spec 36 § Declaring a server). */
export const PROFILES_CAPABILITY = 'tools.noetic/profiles';

/** @public The item type a trigger's event is attached to its turn as (spec 35 § Triggers). */
export const CONNECTION_EVENT_ITEM_TYPE = 'noetic:connection_event';

/** @public Text a resolved secret value is replaced with wherever it would be stored, traced or shown. */
export const REDACTED_TEXT = '<redacted>';

/** @public How long a pool lease may go unrenewed before it is reclaimed (spec 35 § Pools and leases). */
export const LEASE_RECLAIM_MS = 12e4;

/** @public How often the holding harness renews a pool lease (spec 35 § Pools and leases). */
export const LEASE_RENEW_MS = 15e3;

/** @public How many events a wait buffers before it drops the oldest and records a gap (spec 35 § Events). */
export const WAIT_BUFFER_LIMIT = 1e4;

//#endregion

//#region Values: refs, blobs, secrets, receipts

/** @public The body of a ref: who issued it, what kind of thing it names, its id, and the harness seal. */
export interface RefBody<K extends string = string> {
  readonly connection: string;
  readonly kind: K;
  readonly id: string;
  /** HMAC over the rest, the issuing thread and, for volatile refs, the connection's identity instance. */
  readonly seal: string;
}

/**
 * @public
 * An id a connection handed out — a thread, a message, an installed app. Pass it
 * back as you got it; the harness routes the call to the connection that issued
 * it. The same shape in TypeScript and JSON: `{ "$ref": { connection, kind, id, seal } }`.
 * Read its id with `refId(ref)` (in an expression, `$refId(x)`).
 */
export interface Ref<K extends string = string> {
  readonly $ref: RefBody<K>;
}

/** @public The body of a blob reference: content address, type and size. */
export interface BlobRefBody {
  /** `artifact://sha256/<hex>`. */
  readonly uri: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * @public
 * Binary content — a screenshot, a recording, a download — stored once in the
 * artifact store (`08-runtime`) and passed around as this small reference.
 */
export interface BlobRef {
  readonly $blob: BlobRefBody;
}

/** @public Spec 08's name for a blob reference; identical to `BlobRef`. */
export type BlobReference = BlobRef;

/**
 * @public
 * A secret, by name: resolved through `environment.secrets` only when the call is
 * sent, never stored, logged or shown to the model, and allowed only in fields a
 * profile marks `sensitive`. JSON: `{ "$secret": "app.password" }`.
 */
export interface Secret<N extends string = string> {
  readonly $secret: N;
}

/**
 * @public
 * What every `effects` operation returns: the action was sent, and when — never
 * whether it worked.
 */
export interface Receipt {
  readonly actionId: string;
  readonly cursor: string | null;
}

/** @public A locator string where an operation expects an element: `'button "Pay"'` (role, then quoted name). */
export type Locator = string;

/** @public A field accepting a ref of kind `K` or a locator, resolved by the server to exactly one thing. */
export type Target<K extends string = string> = Ref<K> | Locator;

const REF_BODY_SHAPE = {
  connection: z.string().min(1),
  id: z.string().min(1),
  seal: z.string().min(1),
} as const;

/** @public Zod schema for any `Ref`. */
export const RefSchema: z.ZodType<Ref, Ref> = z
  .object({
    $ref: z
      .object({
        ...REF_BODY_SHAPE,
        kind: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/** @public Zod schema for a `Ref` of one kind. */
export function refSchemaOf<K extends string>(kind: K): z.ZodType<Ref<K>, Ref<K>> {
  return z
    .object({
      $ref: z
        .object({
          ...REF_BODY_SHAPE,
          kind: z.literal(kind),
        })
        .strict(),
    })
    .strict();
}

/** @public Zod schema for a `BlobRef`. */
export const BlobRefSchema: z.ZodType<BlobRef, BlobRef> = z
  .object({
    $blob: z
      .object({
        uri: z.string().min(1),
        mimeType: z.string().min(1),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();

/** @public Zod schema for a `Secret`. */
export const SecretSchema: z.ZodType<Secret, Secret> = z
  .object({
    $secret: z.string().min(1),
  })
  .strict();

/** @public Zod schema for a `Receipt`. */
export const ReceiptSchema: z.ZodType<Receipt, Receipt> = z.object({
  actionId: z.string().min(1),
  cursor: z.string().nullable(),
});

/**
 * @public
 * Names a secret for a `sensitive` field. Resolved through `environment.secrets`
 * immediately before the call is sent.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when `name` is empty.
 */
export function secret<const N extends string>(name: N): Secret<N> {
  if (name.length === 0) {
    throw new NoeticConfigError({
      code: 'CONNECTION_INVALID',
      message: 'secret() needs a name.',
      hint: "Pass the name environment.secrets resolves, e.g. secret('app.password').",
    });
  }
  return {
    $secret: name,
  };
}

function hasObjectKey(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && key in value;
}

/** @public Whether `value` is a well-formed `Ref`. */
export function isRef(value: unknown): value is Ref {
  return hasObjectKey(value, '$ref') && RefSchema.safeParse(value).success;
}

/** @public Whether `value` is a well-formed `BlobRef`. */
export function isBlobRef(value: unknown): value is BlobRef {
  return hasObjectKey(value, '$blob') && BlobRefSchema.safeParse(value).success;
}

/** @public Whether `value` is a well-formed `Secret`. */
export function isSecret(value: unknown): value is Secret {
  return hasObjectKey(value, '$secret') && SecretSchema.safeParse(value).success;
}

/** @public The id inside a ref (`$refId(x)` in an expression). */
export function refId(ref: Ref): string {
  return ref.$ref.id;
}

//#endregion

//#region Errors (wire)

/** @public The error codes a server returns in `structuredContent.code` (spec 36 § Errors). */
export const ConnectionErrorCode = {
  Undeclared: 'undeclared',
  Unsupported: 'unsupported',
  Unresolved: 'unresolved',
  Ambiguous: 'ambiguous',
  Unavailable: 'unavailable',
  Guarded: 'guarded',
  Malformed: 'malformed',
  StaleReference: 'stale_reference',
  NotFound: 'not_found',
  PermissionDenied: 'permission_denied',
  RateLimited: 'rate_limited',
  Busy: 'busy',
  Conflict: 'conflict',
} as const;

/** @public One of `ConnectionErrorCode`. */
export type ConnectionErrorCode = (typeof ConnectionErrorCode)[keyof typeof ConnectionErrorCode];

/** @public A refused or failed operation, as a server reports it. `ambiguous` carries `details.candidates`. */
export interface ConnectionErrorPayload {
  readonly code: ConnectionErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** @public Zod schema for `ConnectionErrorPayload` (an MCP tool error's `structuredContent`). */
export const ConnectionErrorPayloadSchema: z.ZodType<ConnectionErrorPayload> = z.object({
  code: z.enum([
    'undeclared',
    'unsupported',
    'unresolved',
    'ambiguous',
    'unavailable',
    'guarded',
    'malformed',
    'stale_reference',
    'not_found',
    'permission_denied',
    'rate_limited',
    'busy',
    'conflict',
  ]),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** @public `NoeticConfigError` codes for connection setup and validation (spec 35 § Errors). */
export const ConnectionConfigErrorCode = {
  Unknown: 'CONNECTION_UNKNOWN',
  Unsatisfied: 'CONNECTION_UNSATISFIED',
  NotAllowed: 'CONNECTION_NOT_ALLOWED',
  Invalid: 'CONNECTION_INVALID',
  ToolCollision: 'CONNECTION_TOOL_COLLISION',
} as const;

/** @public One of `ConnectionConfigErrorCode`. */
export type ConnectionConfigErrorCode =
  (typeof ConnectionConfigErrorCode)[keyof typeof ConnectionConfigErrorCode];

/** @public What a connection did not offer (`CONNECTION_UNSATISFIED`'s `missing`). */
export type ConnectionMissing =
  | {
      readonly kind: 'profile';
      readonly profile: string;
      readonly range: string;
    }
  | {
      readonly kind: 'extension';
      readonly extension: string;
      readonly range: string;
    }
  | {
      readonly kind: 'operation';
      readonly op: string;
    }
  | {
      readonly kind: 'event';
      readonly event: string;
    }
  | {
      readonly kind: 'sense';
      readonly sense: string;
    };

//#endregion

//#region Provider contract

/** @public A JSON Schema object, as a server or profile publishes it. */
export type JsonSchemaObject = Readonly<Record<string, unknown>>;

/** @public The OVP subject a connection drives: `instance` changes whenever the thing is replaced. */
export interface ConnectionIdentity {
  readonly surface: string;
  readonly instance: string;
  /** Non-negative; moves on code edits. Absent when edits cannot be seen. */
  readonly epoch?: number;
}

/** @public Where a manifest part comes from. */
export interface ConnectionPartOrigin {
  /** The profile (`'browser'`) that defines it, when it is a profile part. */
  readonly profile?: string;
  /** The extension id that defines it, when it is an extension part. */
  readonly extension?: string;
}

/** @public One operation a connection offers. */
export interface ConnectionOperationInfo extends ConnectionPartOrigin {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema?: JsonSchemaObject;
  readonly eager?: boolean;
  readonly effects?: boolean;
  readonly once?: boolean;
  readonly guarded?: boolean;
  readonly sense?: SenseId;
}

/** @public One readable resource (a profile `read`). */
export interface ConnectionResourceInfo extends ConnectionPartOrigin {
  readonly name: string;
  readonly description?: string;
  readonly schema?: JsonSchemaObject;
  readonly sense?: SenseId;
  readonly look?: LookMode;
}

/** @public One event a connection can deliver. */
export interface ConnectionEventInfo extends ConnectionPartOrigin {
  readonly name: string;
  readonly description?: string;
  readonly payloadSchema?: JsonSchemaObject;
  readonly argumentsSchema?: JsonSchemaObject;
  readonly sense?: SenseId;
  readonly replay: ReplayMode;
  /** The payload field naming the event's natural thread. */
  readonly thread?: string;
}

/** @public What a connection offers: profiles, extensions, operations, resources, events, senses. */
export interface ConnectionManifest {
  /** Profile name → implemented version (`{ browser: '1.2.0', ui: '1.1.0' }`). */
  readonly profiles: Readonly<Record<string, string>>;
  /** Extension id → implemented version. */
  readonly extensions: Readonly<Record<string, string>>;
  readonly operations: Readonly<Record<string, ConnectionOperationInfo>>;
  readonly resources: Readonly<Record<string, ConnectionResourceInfo>>;
  readonly events: Readonly<Record<string, ConnectionEventInfo>>;
  /** Sense → OVP channel descriptor, as the server declares it. */
  readonly senses: Readonly<Record<string, SenseDescriptor>>;
  readonly determinism?: Determinism;
  /** JSON Schema of the setup a pool accepts. */
  readonly setup?: JsonSchemaObject;
}

/** @public A question a long-running operation asked (MCP Tasks `input_required`). */
export interface ConnectionInputRequest {
  readonly id: string;
  readonly message: string;
  readonly schema?: JsonSchemaObject;
}

/** @public Options for one call. */
export interface CallOptions {
  readonly signal: AbortSignal;
  /** Sent as `_meta["tools.noetic/idempotency-key"]`. */
  readonly idempotencyKey: string;
  /** Set only by the harness after approval; sent as `_meta["tools.noetic/confirmed"]`. */
  readonly confirmed?: boolean;
}

/** @public A call's immediate outcome: a result, a refusal, or a long operation to wait on. */
export type CallResult =
  | {
      readonly status: 'ok';
      readonly output: unknown;
    }
  | {
      readonly status: 'error';
      readonly error: ConnectionErrorPayload;
    }
  | {
      readonly status: 'task';
      readonly taskId: string;
    };

/** @public A call's final outcome. */
export type CallOutcome = Exclude<
  CallResult,
  {
    status: 'task';
  }
>;

/** @public The state of a long-running operation. */
export type ConnectionTaskState =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** @public Progress of a long-running operation. */
export interface ConnectionTaskStatus {
  readonly taskId: string;
  readonly state: ConnectionTaskState;
  readonly message?: string;
  readonly progress?: {
    readonly current: number;
    readonly total?: number;
  };
  /** Present when `state` is `'input_required'`. */
  readonly request?: ConnectionInputRequest;
}

/** @public Long-running operations (MCP Tasks extension, SEP-2663). */
export interface ConnectionTasks {
  get(
    taskId: string,
    opts: {
      signal: AbortSignal;
    },
  ): Promise<ConnectionTaskStatus>;
  /** Waits for the task to finish, reporting progress as it goes. */
  result(
    taskId: string,
    opts: {
      signal: AbortSignal;
      onProgress?: (status: ConnectionTaskStatus) => void;
    },
  ): Promise<CallOutcome>;
  cancel(taskId: string): Promise<void>;
  /** Answers an `input_required` request. */
  respond(taskId: string, requestId: string, answer: unknown): Promise<void>;
}

/** @public An event as the harness sees it (SEP-3415 `eventId`, `name`, `timestamp`, `data`). */
export interface ConnectionEvent<T = unknown> {
  readonly id: string;
  readonly type: string;
  readonly time: string;
  readonly payload: T;
  readonly cursor: string | null;
  /** Stamped by the harness. */
  readonly connection: string;
  /** The action it is attributed to. */
  readonly actionId?: string;
}

/** @public An event as a provider yields it, before the harness stamps `connection`. */
export type ConnectionEventInit<T = unknown> = Omit<ConnectionEvent<T>, 'connection'>;

/** @public A request to listen for one event type. */
export interface ListenRequest {
  readonly event: string;
  /** Server-side filter arguments, validated against the event's `arguments` schema. */
  readonly arguments?: Readonly<Record<string, unknown>>;
  /** Resume after this cursor; `null` or absent listens from now. */
  readonly cursor?: string | null;
  readonly signal: AbortSignal;
}

/** @public One message on an event stream: an event, a gap, or the end of the stream. */
export type EventStreamMessage<E = ConnectionEventInit> =
  | {
      readonly type: 'event';
      readonly event: E;
    }
  | {
      readonly type: 'gap';
      readonly reason: string;
      readonly from?: string | null;
      readonly to?: string | null;
    }
  | {
      readonly type: 'terminated';
      readonly reason: string;
    };

/** @public A live subscription. Iterate it for messages; `ready` resolves once the server confirms. */
export interface EventStream<E = ConnectionEventInit> extends AsyncIterable<EventStreamMessage<E>> {
  /** Resolves when the server confirms the subscription, with the cursor listening starts from. */
  readonly ready: Promise<{
    cursor: string | null;
  }>;
  close(): Promise<void>;
}

/** @public What a provider is given when it connects. */
export interface ConnectOptions {
  /** The harness connection name (or pool name) being connected. */
  readonly name: string;
  readonly signal: AbortSignal;
  /** Where binary content goes; the bridge replaces it with `BlobRef`s. */
  readonly artifacts: ArtifactStore;
  /**
   * Profiles and extensions the harness knows of — the ones its handles name. A
   * provider that checks a server's declaration against profile definitions uses
   * them alongside its own, so `connection('app', browser)` alone carries the
   * profile's flags and schemas (spec 36 § Using a profile).
   */
  readonly profiles?: ReadonlyArray<AnyProfile>;
  readonly extensions?: ReadonlyArray<AnyExtension>;
}

/** @public A live connection, as a provider implements it. Steps and tools never hold one directly. */
export interface Connection {
  readonly id: string;
  readonly manifest: ConnectionManifest;
  /** OVP subject. */
  readonly identity: ConnectionIdentity;
  call(op: string, args: unknown, opts: CallOptions): Promise<CallResult>;
  read(
    resource: string,
    opts: {
      signal: AbortSignal;
    },
  ): Promise<unknown>;
  listen(req: ListenRequest): EventStream;
  readonly tasks: ConnectionTasks;
  reset?(opts: { signal: AbortSignal }): Promise<void>;
  onChange(listener: (change: 'manifest' | 'identity') => void): () => void;
  /**
   * Set while the connection cannot be used though it is still open — a
   * server whose tools came to contradict its declared profile, or whose
   * identity could not be re-read after a change. The registry marks it
   * `unavailable` (calls fail with `connection_unavailable`) until it clears;
   * a change is signalled through `onChange('manifest')`.
   */
  readonly unavailable?: string;
  readonly closed: Promise<{
    reason: string;
  }>;
  release(): Promise<void>;
}

/** @public Backs one or more connections: an MCP server, a source, an in-memory fake. */
export interface ConnectionProvider {
  connect(opts: ConnectOptions): Promise<ReadonlyArray<Connection>>;
  /** Present on providers that can back a pool. */
  provision?(setup: Record<string, unknown>, opts: ConnectOptions): Promise<Connection>;
}

/** @public Whether `value` is a `ConnectionProvider` (has a `connect` function). */
export function isConnectionProvider(value: unknown): value is ConnectionProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    'connect' in value &&
    typeof value.connect === 'function'
  );
}

//#endregion

//#region Harness configuration

/** @public Makes a connection entry a pool of fresh connections. */
export interface ConnectionPoolConfig {
  readonly max: number;
  readonly warm?: number;
  /** How long a request queues when the pool is full; past it, `connection_unavailable`. */
  readonly waitMs?: number;
}

/** @public `allow`, `deny` and `approve` globs over operation names (spec 35 § Gates). */
export interface ConnectionPolicy {
  readonly allow?: ReadonlyArray<string>;
  readonly deny?: ReadonlyArray<string>;
  readonly approve?: ReadonlyArray<string>;
}

/** @public How a connection's operations reach the model. */
export type ConnectionExpose = 'eager' | 'all' | 'none';

/** @public Read name → when it is shown to the model. */
export type ConnectionLook = Readonly<Record<string, LookMode>>;

/** @public A harness `connections` entry in its full form. */
export interface ConnectionConfig {
  readonly provider: ConnectionProvider;
  readonly pool?: ConnectionPoolConfig;
  readonly policy?: ConnectionPolicy;
  /** Default `'eager'`. */
  readonly expose?: ConnectionExpose;
  readonly look?: ConnectionLook;
}

/** @public A harness `connections` entry: a bare provider is shorthand for `{ provider }`. */
export type ConnectionEntry = ConnectionProvider | ConnectionConfig;

/** @public The harness `connections` option. */
export type ConnectionsConfig = Readonly<Record<string, ConnectionEntry>>;

/** @public Expands a bare provider to `{ provider }`. */
export function normalizeConnectionEntry(entry: ConnectionEntry): ConnectionConfig {
  if ('provider' in entry) {
    return entry;
  }
  return {
    provider: entry,
  };
}

/** @public Resolves `secret()` names (`environment.secrets`). */
export interface SecretResolver {
  resolve(
    name: string,
    opts: {
      signal: AbortSignal;
    },
  ): Promise<string>;
}

/** @public Starts or joins a turn when a connection reports an event. */
export interface ConnectionTrigger<P = unknown> {
  readonly id: string;
  /** A harness connection name. */
  readonly connection: string;
  readonly event: string;
  /** Filter on the server. */
  readonly arguments?: Readonly<Record<string, unknown>>;
  /** Filter here. */
  readonly filter?: (event: ConnectionEvent<P>) => boolean;
  /** The message the turn starts with. */
  readonly input: (event: ConnectionEvent<P>) => string;
  /** The thread the turn runs on. Default: the profile's natural thread for the event, else the trigger id. */
  readonly thread?: (event: ConnectionEvent<P>) => string;
}

//#endregion

//#region Sources and cron

/** @public An event a source emits. */
export interface SourceEmitEvent<T extends string = string, P = unknown> {
  readonly type: T;
  readonly id: string;
  readonly payload: P;
  readonly cursor?: string | null;
  /** ISO timestamp; defaults to now. */
  readonly time?: string;
}

/** @public Event type → payload schema. */
export type SourceEventSchemas = Readonly<Record<string, z.ZodType>>;

/** @public The union of events a source with schemas `E` can emit. */
export type SourceEventOf<E extends SourceEventSchemas> = {
  [K in keyof E & string]: SourceEmitEvent<K, z.output<E[K]>>;
}[keyof E & string];

/** @public What a source's `start` receives. */
export interface SourceStartContext<E extends SourceEventSchemas> {
  emit(event: SourceEventOf<E>): Promise<void>;
  /** The last durable cursor a trigger recorded, or `null` on a first start. */
  readonly cursor: string | null;
  readonly signal: AbortSignal;
}

/** @public `defineSource()`'s argument. */
export interface SourceDefinition<E extends SourceEventSchemas> {
  readonly events: E;
  start?(ctx: SourceStartContext<E>): Promise<void> | void;
}

/** @public An in-process event stream registered as a connection. */
export interface ConnectionSource<E extends SourceEventSchemas = SourceEventSchemas>
  extends ConnectionProvider {
  readonly kind: 'source';
  readonly events: E;
  /** Pushes an event from host code. */
  emit(event: SourceEventOf<E>): Promise<void>;
}

/** @public The signature of `defineSource()` (implemented in `@noetic-tools/core`). */
export type DefineSource = <const E extends SourceEventSchemas>(
  definition: SourceDefinition<E>,
) => ConnectionSource<E>;

/** @public `cron()` options. */
export interface CronOptions {
  /** IANA timezone; default UTC. */
  readonly timezone?: string;
}

/** @public The payload of a cron `tick`. */
export interface CronTick {
  /** The scheduled time this tick is for (ISO). */
  readonly scheduledFor: string;
}

/** @public The event schemas of a cron source: one event, `tick`. */
export type CronEvents = {
  readonly tick: z.ZodType<CronTick>;
};

/** @public The signature of `cron()` (implemented in `@noetic-tools/core`). */
export type Cron = (schedule: string, options?: CronOptions) => ConnectionSource<CronEvents>;

//#endregion

//#region Handles and requirements

/** @public How long a fresh connection lives: one per run, or one per parallel path. */
export type FreshScope = 'run' | 'path';

/** @public `connection()`'s options. */
export interface ConnectionHandleOptions {
  /** The harness connection (or pool) to bind to; default the handle's name. */
  readonly from?: string;
  readonly fresh?: FreshScope;
  /** Passed to the pool's provider; validated against the profile's setup schema. */
  readonly setup?: Readonly<Record<string, unknown>>;
  /** Extensions required, each with a range or an `Extension`/`ExtensionRange`. */
  readonly extensions?: ReadonlyArray<AnyExtension | ExtensionRange>;
}

/** @public A connection a workflow needs, as `connection(name, profile?, options?)` returns it. */
export interface ConnectionHandle<P extends AnyProfile | undefined = AnyProfile | undefined> {
  readonly kind: 'connection-handle';
  readonly name: string;
  readonly profile: P;
  /** The profile range required; defaults to `^<installed profile version>`. */
  readonly range?: string;
  readonly options: ConnectionHandleOptions;
}

/** @public The signature of `connection()` (implemented in `@noetic-tools/core`). */
export interface ConnectionFn {
  (
    name: string,
    profile?: undefined,
    options?: ConnectionHandleOptions,
  ): ConnectionHandle<undefined>;
  <P extends AnyProfile>(
    name: string,
    profile: P | ProfileRange<P>,
    options?: ConnectionHandleOptions,
  ): ConnectionHandle<P>;
}

/** @public What a handle or manifest entry requires of a connection, checked at negotiation. */
export interface ConnectionRequirement {
  /** Profile name and semver range (implies its parents' ranges). */
  readonly profile?: {
    readonly name: string;
    readonly range: string;
  };
  /** Extension id → semver range. */
  readonly extensions?: Readonly<Record<string, string>>;
  /** Optional operations derived from use. */
  readonly operations?: ReadonlyArray<string>;
  readonly events?: ReadonlyArray<string>;
  readonly senses?: ReadonlyArray<string>;
}

/** @public What a host lets a document use of one connection (`dynamicWorkflow({ connections })`). */
export interface ConnectionAllowlistEntry {
  /** Operation globs. */
  readonly ops?: ReadonlyArray<string>;
  /** Event globs. */
  readonly events?: ReadonlyArray<string>;
  /** Setup field → allowed value patterns (`*` globs). */
  readonly setup?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Secret name → the one `op.field` it may fill (`'ui.fill.text'`). */
  readonly secrets?: Readonly<Record<string, string>>;
}

/** @public Harness connection name → what a document may use of it. */
export type ConnectionAllowlist = Readonly<Record<string, ConnectionAllowlistEntry>>;

//#endregion

//#region Status and framework events

/** @public A connection's state. */
export type ConnectionState = 'connecting' | 'ready' | 'unavailable' | 'closed';

/** @public A pool lease. */
export interface ConnectionLease {
  readonly id: string;
  readonly pool: string;
  readonly scope: FreshScope;
  /** The run (and, for `'path'`, the parallel path) holding it. */
  readonly holder: string;
  readonly expiresAt: number;
}

/** @public `harness.getConnectionStatus(name?)`'s entries. */
export interface ConnectionStatus {
  readonly name: string;
  readonly state: ConnectionState;
  readonly identity?: ConnectionIdentity;
  readonly reason?: string;
  /** Present for pools. */
  readonly pool?: {
    readonly max: number;
    readonly leased: number;
    readonly idle: number;
  };
}

/** @public The framework event types connections emit on `getFullStream()` (as `<agent>:<type>`). */
export const ConnectionFrameworkEvent = {
  ConnectionChanged: 'connection_changed',
  ConnectionEvent: 'connection_event',
  ConnectionTask: 'connection_task',
  StreamChanged: 'stream_changed',
} as const;

/** @public One of `ConnectionFrameworkEvent`. */
export type ConnectionFrameworkEvent =
  (typeof ConnectionFrameworkEvent)[keyof typeof ConnectionFrameworkEvent];

/** @public `connection_changed` data: state, identity or lease changed. */
export interface ConnectionChangedEventData {
  readonly connection: string;
  readonly state: ConnectionState;
  readonly identity?: ConnectionIdentity;
  readonly lease?: ConnectionLease & {
    readonly change: 'acquired' | 'renewed' | 'released' | 'reclaimed';
  };
  readonly reason?: string;
}

/** @public `connection_event` data: an event received. */
export interface ConnectionEventEventData {
  readonly connection: string;
  /** The trigger that matched it, when it came through one. */
  readonly trigger?: string;
  readonly stepId?: string;
  readonly event: ConnectionEvent;
}

/** @public `connection_task` data: progress of a long operation. */
export interface ConnectionTaskEventData {
  readonly connection: string;
  readonly op: string;
  readonly stepId?: string;
  readonly status: ConnectionTaskStatus;
}

/** @public `stream_changed` data: a gap in, or the end of, an event stream. */
export interface StreamChangedEventData {
  readonly connection: string;
  readonly event: string;
  readonly change: 'gap' | 'ended';
  readonly reason: string;
  readonly stepId?: string;
}

//#endregion
