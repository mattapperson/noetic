/**
 * The wire vocabulary `mcp()` speaks beyond core MCP: the method and
 * notification names of the Tasks extension (SEP-2663) and the Events
 * extension (SEP-3415), the universal Noetic parts every profiled server
 * provides (spec 36 § Parts every server provides), and permissive zod schemas
 * for every result the bridge reads. The SDK has no client API for either
 * extension, so the bridge sends these over its raw request/notification API.
 *
 * Tasks (SEP-2663): a `tools/call` may answer `{ task: { taskId, status } }`
 * instead of a result. `tasks/get { taskId }` reports `status`
 * (`working` · `input_required` · `completed` · `failed` · `cancelled`), an
 * optional `statusMessage`, `progress`, `inputRequests` (request id →
 * `{ message, requestedSchema? }`) while input is required, and the final
 * `result` (a `CallToolResult`) once completed. `tasks/update { taskId,
 * inputResponses }` answers input requests, `tasks/cancel { taskId }` cancels,
 * and `notifications/tasks/status` pushes a status change.
 *
 * Events (SEP-3415): `events/list` lists event types, each naming the delivery
 * modes it offers. Poll: `events/poll { name, arguments?, cursor }` →
 * `{ events, cursor, truncated?, hasMore?, nextPollMs? }`; a subscription that
 * ended answers with a JSON-RPC error. Push: `events/stream` stays open, and
 * `notifications/events/{active,event,heartbeat,error,terminated}` name their
 * stream by the request's id under `_meta[SUBSCRIPTION_META]`. Webhook:
 * `events/subscribe` with `delivery: { mode, url, secret }` →
 * `{ id, refreshBefore, cursor, truncated? }`, then Standard Webhooks POSTs
 * whose body is an event, or a control envelope with a `type` (`gap`,
 * `terminated`, `verification`); `events/unsubscribe { name, arguments?,
 * delivery: { url } }` ends it. A wire event is `{ eventId, name, timestamp,
 * data, cursor? }`; `actionId` is Noetic's addition.
 */

import { z } from 'zod';

//#region Capability keys and names

/** @public The MCP `extensions` capability key of the Tasks extension (SEP-2663). */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/** @public The MCP `extensions` capability key of the Events extension (SEP-3415). */
export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';

/** @public The resource every profiled server serves its OVP subject at. */
export const IDENTITY_URI = 'noetic://identity';

/** @public The optional resource listing OVP blind spots since a cursor. */
export const COVERAGE_URI = 'noetic://coverage';

/** @public The event a profiled server sends when its identity changes. */
export const IDENTITY_CHANGED_EVENT = 'identity.changed';

/** @public The universal tools of spec 36 § Parts every server provides. */
export const UniversalTool = {
  Reset: 'noetic.reset',
  Provision: 'noetic.provision',
  Release: 'noetic.release',
  Detect: 'noetic.detect',
} as const;

/** @public One of `UniversalTool`. */
export type UniversalTool = (typeof UniversalTool)[keyof typeof UniversalTool];

/** @public The request methods the bridge sends. */
export const McpMethod = {
  ToolsCall: 'tools/call',
  ToolsList: 'tools/list',
  ResourcesList: 'resources/list',
  ResourcesRead: 'resources/read',
  ResourcesSubscribe: 'resources/subscribe',
  TasksGet: 'tasks/get',
  TasksUpdate: 'tasks/update',
  TasksCancel: 'tasks/cancel',
  EventsList: 'events/list',
  EventsStream: 'events/stream',
  EventsSubscribe: 'events/subscribe',
  EventsPoll: 'events/poll',
  EventsUnsubscribe: 'events/unsubscribe',
} as const;

/** @public The notifications the bridge listens for. */
export const McpNotification = {
  ToolsListChanged: 'notifications/tools/list_changed',
  ResourcesListChanged: 'notifications/resources/list_changed',
  ResourceUpdated: 'notifications/resources/updated',
  EventsListChanged: 'notifications/events/list_changed',
  TaskStatus: 'notifications/tasks/status',
  EventsActive: 'notifications/events/active',
  EventsEvent: 'notifications/events/event',
  EventsHeartbeat: 'notifications/events/heartbeat',
  EventsError: 'notifications/events/error',
  EventsTerminated: 'notifications/events/terminated',
} as const;

/** @public How a server delivers events. */
export type EventDelivery = 'push' | 'webhook' | 'poll';

/** @public The `_meta` key a push notification names its `events/stream` request under. */
export const SUBSCRIPTION_META = 'io.modelcontextprotocol/subscriptionId';

/** @public The header a webhook delivery names its subscription in. */
export const SUBSCRIPTION_HEADER = 'x-mcp-subscription-id';

//#endregion

//#region Result schemas

/** @public One MCP content block, loosely. */
export const ContentBlockSchema = z.looseObject({
  type: z.string(),
});

/** @public A `CallToolResult`, loosely. */
export const ToolResultSchema = z.looseObject({
  content: z.array(ContentBlockSchema).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

/** @public A `CallToolResult`, loosely. */
export type ToolResult = z.infer<typeof ToolResultSchema>;

/** @public The task states of SEP-2663. */
export const TaskStateSchema = z.enum([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);

/** @public What `tools/call` answers: a result, or a task to wait on. */
export const CallResponseSchema = z.looseObject({
  content: z.array(ContentBlockSchema).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
  task: z
    .looseObject({
      taskId: z.string().min(1),
      status: TaskStateSchema.optional(),
      pollInterval: z.number().positive().optional(),
    })
    .optional(),
});

/**
 * @public
 * A tool's `annotations`. Each hint is optional and a malformed one is
 * dropped, so a server's bad hint never costs it its tool.
 */
export const ToolAnnotationsSchema = z.looseObject({
  title: z.string().optional().catch(undefined),
  readOnlyHint: z.boolean().optional().catch(undefined),
  destructiveHint: z.boolean().optional().catch(undefined),
  idempotentHint: z.boolean().optional().catch(undefined),
  openWorldHint: z.boolean().optional().catch(undefined),
});

/** @public One tool, as `tools/list` describes it. */
export const ToolInfoSchema = z.looseObject({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: ToolAnnotationsSchema.optional().catch(undefined),
  execution: z
    .looseObject({
      taskSupport: z.string().optional(),
    })
    .optional(),
});

/** @public One tool, as `tools/list` describes it. */
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

/** @public A page of `tools/list`. */
export const ToolListSchema = z.looseObject({
  tools: z.array(ToolInfoSchema),
  nextCursor: z.string().optional(),
});

/** @public One resource, as `resources/list` describes it. */
export const ResourceInfoSchema = z.looseObject({
  uri: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

/** @public One resource, as `resources/list` describes it. */
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;

/** @public A page of `resources/list`. */
export const ResourceListSchema = z.looseObject({
  resources: z.array(ResourceInfoSchema),
  nextCursor: z.string().optional(),
});

/** @public The contents of one resource. */
export const ResourceContentSchema = z.looseObject({
  uri: z.string(),
  mimeType: z.string().optional(),
  text: z.string().optional(),
  blob: z.string().optional(),
});

/** @public A `resources/read` result. */
export const ReadResourceResultSchema = z.looseObject({
  contents: z.array(ResourceContentSchema),
});

/** @public A task status, as `tasks/get` and `notifications/tasks/status` report it. */
export const TaskStatusSchema = z.looseObject({
  taskId: z.string().min(1),
  status: TaskStateSchema,
  statusMessage: z.string().optional(),
  progress: z
    .object({
      current: z.number(),
      total: z.number().optional(),
    })
    .optional(),
  inputRequests: z
    .record(
      z.string(),
      z.looseObject({
        message: z.string(),
        requestedSchema: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  result: ToolResultSchema.optional(),
  error: z
    .looseObject({
      code: z.unknown().optional(),
      message: z.string(),
    })
    .optional(),
  pollInterval: z.number().positive().optional(),
});

/** @public A task status, as `tasks/get` reports it. */
export type WireTaskStatus = z.infer<typeof TaskStatusSchema>;

/** @public An empty result. */
export const EmptyResultSchema = z.looseObject({});

const DeliverySchema = z.enum([
  'push',
  'webhook',
  'poll',
]);

/**
 * @public One event type, as `events/list` describes it. `replay`, `sense` and
 * `thread` are Noetic's additions.
 */
export const EventInfoSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  delivery: z.array(DeliverySchema).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  payloadSchema: z.record(z.string(), z.unknown()).optional(),
  replay: z
    .enum([
      'durable',
      'live',
      'none',
    ])
    .optional(),
  sense: z.string().optional(),
  thread: z.string().optional(),
});

/** @public One event type, as `events/list` describes it. */
export type EventInfo = z.infer<typeof EventInfoSchema>;

/** @public A page of `events/list`. */
export const EventListSchema = z.looseObject({
  events: z.array(EventInfoSchema),
  nextCursor: z.string().optional(),
});

/** @public One event on the wire. */
export const WireEventSchema = z.looseObject({
  eventId: z.string().min(1),
  name: z.string().min(1),
  timestamp: z.string(),
  data: z.unknown(),
  cursor: z.string().nullish(),
  actionId: z.string().optional(),
});

/** @public One event on the wire. */
export type WireEvent = z.infer<typeof WireEventSchema>;

/** @public Why a subscription ended, or what went wrong on it. */
export const WireErrorSchema = z.looseObject({
  code: z.number().optional(),
  message: z.string(),
  data: z.unknown().optional(),
});

/** @public An `events/poll` result. */
export const PollResultSchema = z.looseObject({
  events: z.array(WireEventSchema),
  cursor: z.string().nullish(),
  /** The server started later than the cursor asked: events may be missing. */
  truncated: z.boolean().optional(),
  /** More is ready: poll again at once. */
  hasMore: z.boolean().optional(),
  nextPollMs: z.number().nonnegative().optional(),
});

/** Names the `events/stream` request a push notification belongs to. */
const StreamMetaSchema = z.looseObject({
  [SUBSCRIPTION_META]: z.union([
    z.string(),
    z.number(),
  ]),
});

/** @public `notifications/events/active`: the stream is confirmed, or has skipped ahead. */
export const StreamActiveParamsSchema = z.looseObject({
  cursor: z.string().nullish(),
  truncated: z.boolean().optional(),
  heartbeatMs: z.number().positive().optional(),
  _meta: StreamMetaSchema,
});

/** @public `notifications/events/event`: one event on a stream. */
export const StreamEventParamsSchema = WireEventSchema.extend({
  _meta: StreamMetaSchema,
});

/** @public `notifications/events/heartbeat`: the stream is alive, and how far it has read. */
export const StreamHeartbeatParamsSchema = z.looseObject({
  cursor: z.string().nullish(),
  _meta: StreamMetaSchema,
});

/** @public `notifications/events/error` and `notifications/events/terminated`. */
export const StreamErrorParamsSchema = z.looseObject({
  error: WireErrorSchema,
  _meta: StreamMetaSchema,
});

/** @public An `events/subscribe` result. */
export const SubscribeResultSchema = z.looseObject({
  id: z.string().min(1),
  /** When to subscribe again by; `null` for a subscription that does not expire. */
  refreshBefore: z.string().nullish(),
  cursor: z.string().nullish(),
  truncated: z.boolean().optional(),
});

/** @public A webhook body that is not an event: it has a `type`. */
export const WebhookControlSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('gap'),
    cursor: z.string().nullish(),
  }),
  z.looseObject({
    type: z.literal('terminated'),
    error: WireErrorSchema,
  }),
  z.looseObject({
    type: z.literal('verification'),
    challenge: z.string().min(1),
  }),
]);

/** @public `noetic://identity`'s content. */
export const IdentitySchema = z.object({
  surface: z.string().min(1),
  instance: z.string().min(1),
  epoch: z.number().int().nonnegative().optional(),
});

/** @public `noetic.provision`'s structured result. */
export const ProvisionResultSchema = z.looseObject({
  instance: z.string().min(1),
});

//#endregion
