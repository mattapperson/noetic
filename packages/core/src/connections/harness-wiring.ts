/**
 * How an `AgentHarness` holds its connections (spec 35 § Configuring
 * connections, § Triggers; spec 08 § Connections and Triggers): the registry,
 * the trigger runner, the connection view layers, and the gate hooks that
 * route gate 5 through the harness's `beforeToolCall` layers and approver.
 *
 * Construction is synchronous and validates the configuration; providers
 * connect and triggers start listening in `start()`.
 */

import type {
  ArtifactStore,
  ConnectionsConfig,
  ConnectionTrigger,
  Context,
  ContextLayer,
  ExecuteInput,
  ExecuteOptions,
  Item,
  SecretResolver,
  SessionScope,
  SteeringDecision,
  StorageAdapter,
  Tool,
  ToolApprover,
} from '@noetic-tools/types';
import {
  CONNECTION_EVENT_ITEM_TYPE,
  createMessage,
  frameworkCast,
  SteeringAction,
} from '@noetic-tools/types';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import type { GateHooks, GateRequest } from './gates';
import { buildConnectionTools } from './model-tools';
import type { ConnectionFrameworkEventRecord, ConnectionRuntime } from './registry';
import { createConnectionRuntime } from './registry';
import { runEvery } from './settle';
import type { TriggerDelivery } from './triggers';
import { TriggerRunner, validateTriggers } from './triggers';
import { connectionViewLayers } from './views';

//#region Types

/** The harness surface the wiring calls back into. */
export interface WiredHarness {
  readonly config: {
    readonly name: string;
    readonly approveToolCall?: ToolApprover;
  };
  beforeToolCall(
    layers: ContextLayer[],
    toolName: string,
    toolArgs: unknown,
    ctx: Context,
    callId?: string,
  ): Promise<SteeringDecision>;
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void>;
  getAgentResponse(scope?: SessionScope): Promise<unknown>;
}

/** `createHarnessConnections` options. */
export interface HarnessConnectionsOptions {
  readonly harness: WiredHarness;
  readonly connections?: ConnectionsConfig;
  readonly triggers?: ReadonlyArray<ConnectionTrigger>;
  readonly storage: StorageAdapter;
  readonly artifacts: ArtifactStore;
  readonly secrets?: SecretResolver;
  /** Every session broadcaster, for events that concern no one context. */
  readonly broadcasters: () => Iterable<EventBroadcaster>;
}

/** A harness's connections. */
export interface HarnessConnections {
  readonly registry: ConnectionRuntime;
  /** One view layer per non-pool connection. */
  readonly views: ReadonlyArray<ContextLayer>;
  /** Connects providers and starts triggers. Idempotent. */
  start(): Promise<void>;
  /** Stops triggers and releases every connection. */
  close(): Promise<void>;
  /** This turn's connection tools. */
  tools(): Tool[];
}

//#endregion

//#region Helpers

function deny(guidance: string): SteeringDecision {
  return {
    action: SteeringAction.Deny,
    guidance,
  };
}

function gateHooks(harness: WiredHarness): GateHooks {
  return {
    async beforeCall(request: GateRequest): Promise<SteeringDecision> {
      const layers = request.ctx?.layers;
      if (!request.ctx || !layers || layers.length === 0) {
        return {
          action: SteeringAction.Allow,
        };
      }
      return harness.beforeToolCall(
        layers,
        request.toolName,
        request.args,
        request.ctx,
        request.callId,
      );
    },
    async approve(request: GateRequest): Promise<SteeringDecision> {
      const approver = harness.config.approveToolCall;
      if (!approver) {
        return deny(
          `'${request.op}' on connection '${request.connection}' needs approval, but the harness has no approveToolCall`,
        );
      }
      if (!request.ctx) {
        return deny(`'${request.op}' needs approval, but the call has no context to ask from`);
      }
      try {
        return await approver({
          toolName: request.toolName,
          toolArgs: request.args,
          callId: request.callId,
          ctx: request.ctx,
        });
      } catch (e) {
        return deny(`approval failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function broadcast(
  options: HarnessConnectionsOptions,
  event: ConnectionFrameworkEventRecord,
): void {
  const data = frameworkCast<Record<string, unknown>>(event.data);
  const own = event.ctx ? getBroadcaster(event.ctx) : undefined;
  const targets = own
    ? [
        own,
      ]
    : [
        ...options.broadcasters(),
      ];
  for (const broadcaster of targets) {
    emitFrameworkEvent({
      broadcaster,
      agentName: options.harness.config.name,
      eventType: event.type,
      data,
    });
  }
}

async function deliverTurn(harness: WiredHarness, delivery: TriggerDelivery): Promise<void> {
  const eventItem = frameworkCast<Item>({
    type: CONNECTION_EVENT_ITEM_TYPE,
    id: `connection-event-${delivery.messageId}`,
    trigger: delivery.trigger,
    event: delivery.event,
  });
  await harness.execute(
    [
      createMessage(delivery.input, 'user'),
      eventItem,
    ],
    {
      threadId: delivery.threadId,
      messageId: delivery.messageId,
    },
  );
  await harness.getAgentResponse({
    threadId: delivery.threadId,
  });
}

//#endregion

//#region Public API

/**
 * Builds a harness's connections from its options.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for a malformed entry or trigger,
 * `CONNECTION_UNKNOWN` for a trigger naming an unknown connection.
 */
export function createHarnessConnections(options: HarnessConnectionsOptions): HarnessConnections {
  const registry = createConnectionRuntime({
    connections: options.connections,
    storage: options.storage,
    artifacts: options.artifacts,
    secrets: options.secrets,
    hooks: gateHooks(options.harness),
    onFrameworkEvent: (event) => broadcast(options, event),
  });
  const triggers = options.triggers ?? [];
  validateTriggers(triggers, registry.names());
  const runner =
    triggers.length > 0
      ? new TriggerRunner({
          runtime: registry,
          triggers,
          storage: options.storage,
          deliver: (delivery) => deliverTurn(options.harness, delivery),
        })
      : undefined;
  const views = connectionViewLayers(registry);
  let starting: Promise<void> | undefined;
  return {
    registry,
    views,
    start(): Promise<void> {
      starting ??= (async (): Promise<void> => {
        await registry.start();
        await runner?.start();
      })();
      return starting;
    },
    async close(): Promise<void> {
      await runEvery([
        () => runner?.close(),
        () => registry.close(),
      ]);
    },
    tools: () => buildConnectionTools(registry),
  };
}

//#endregion
