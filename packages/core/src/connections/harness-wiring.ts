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
  ConnectionEntries,
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
import { ContextImpl } from '../runtime/context-impl';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import { heldArgsHash, holdAndWait } from '../runtime/held-calls';
import { askApproval, awaitApproval } from '../runtime/tool-approval';
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
  readonly connections?: ConnectionEntries;
  readonly triggers?: ReadonlyArray<ConnectionTrigger>;
  /** A scheduled trigger moved on (`TriggerRunnerOptions.onSchedule`). */
  readonly onSchedule?: () => Promise<void>;
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
  /** A turn's connection tools: the harness's, and the ones attached under `rootId`. */
  tools(rootId?: string): Tool[];
  /** The harness's triggers: its own, and those added while it runs. */
  readonly triggers: TriggerRunner;
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
    // A long operation asked a question (MCP Tasks `input_required`). It is held for
    // a person like a tool's open result: the answer goes back to the operation.
    async answerInput(request) {
      const question = request.status.request;
      if (!request.ctx || !question) {
        return undefined;
      }
      const args = {
        taskId: request.status.taskId,
        question: question.message,
      };
      const answer = await holdAndWait({
        harness,
        ctx: request.ctx,
        record: {
          callId: `${holdIdOf(request.ctx, request.callId ?? request.op)}:input:${question.id}`,
          name: request.toolName,
          args,
          argsHash: heldArgsHash(request.toolName, args),
          reason: 'result',
          request: question,
        },
      });
      return answer.resolution?.hasOutput
        ? {
            answer: answer.resolution.output,
          }
        : undefined;
    },
    async approve(request: GateRequest): Promise<SteeringDecision> {
      // A model's tool call can be held for a person: its tool pipeline writes the
      // record when this throws, and answers from it when the call is made again.
      if (request.ctx && request.caller === 'model' && request.callId !== undefined) {
        const approval = await askApproval({
          harness,
          toolName: request.toolName,
          toolArgs: request.args,
          callId: request.callId,
          ctx: request.ctx,
          matched: true,
        });
        return approval.decision;
      }
      // A step's call has no round to come back to, so it waits where it is until a
      // person answers, and the turn may park meanwhile.
      if (request.ctx && request.caller === 'step' && request.callId !== undefined) {
        const approval = await awaitApproval({
          harness,
          toolName: request.toolName,
          toolArgs: request.args,
          callId: holdIdOf(request.ctx, request.callId),
          ctx: request.ctx,
        });
        return approval.decision;
      }
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

/**
 * The id a step's held call is kept under: its dispatch path, since a step id
 * repeats across loop iterations and a path does not.
 */
function holdIdOf(ctx: Context, fallback: string): string {
  return (ctx instanceof ContextImpl ? ctx.currentDispatch()?.path : undefined) ?? fallback;
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
  // Always built: a trigger can be added while the harness runs, and ones added on
  // an earlier run are read back from storage at start.
  const runner = new TriggerRunner({
    runtime: registry,
    triggers,
    storage: options.storage,
    onSchedule: options.onSchedule,
    deliver: (delivery) => deliverTurn(options.harness, delivery),
  });
  const views = connectionViewLayers(registry);
  let starting: Promise<void> | undefined;
  return {
    registry,
    views,
    start(): Promise<void> {
      starting ??= (async (): Promise<void> => {
        await registry.start();
        await runner.start();
      })();
      return starting;
    },
    async close(): Promise<void> {
      await runEvery([
        () => runner.close(),
        () => registry.close(),
      ]);
    },
    tools: (rootId) => buildConnectionTools(registry, rootId),
    triggers: runner,
  };
}

//#endregion
