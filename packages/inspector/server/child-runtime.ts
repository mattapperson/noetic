/**
 * Boots the user's agent inside a child process: imports the agent file,
 * builds the harness with injected storage + tracing, seeds the persisted
 * session, and starts the pumps that mirror harness streams onto the SSE hub.
 *
 * The child is spawned fresh for every code revision (Bun caches modules, so
 * in-process re-import would never re-execute the edited file — the
 * `eval/src/cli/watch-runner.ts` rationale). All state that must survive a
 * revision lives outside the process: chat history in the session store,
 * durable layer state in file storage.
 */

import path from 'node:path';
import type { AgentHarness, ContextLayer, StorageAdapter } from '@noetic-tools/core';
import { InMemoryExporter, seedFromItems } from '@noetic-tools/core';
import { createFileStorage } from '@noetic-tools/platform-node';
import { z } from 'zod';
import type { ExecutionTracker } from './layer-events';
import { decorateLayerStateStore } from './layer-events';
import type { SessionStore } from './session-store';
import { createJsonlSessionStore } from './session-store';
import type { SseHub } from './sse-hub';
import type { LayerInfo } from './wire-types';

//#region Types

export interface ChildConfig {
  agentFile: string;
  dataDir: string;
  threadId: string;
}

export interface AgentBoot {
  harness: AgentHarness;
  exporter: InMemoryExporter;
  storage: StorageAdapter;
  sessionStore: SessionStore;
  execIds: ExecutionTracker;
  layers: LayerInfo[];
  /** Run `fn` with layer-state change events suppressed (preview writes). */
  suppressed<T>(fn: () => Promise<T>): Promise<T>;
}

/** What the child injects into the user's factory. Storage makes durable
 *  layer state land in the inspector's data dir; the exporter feeds /trace. */
export interface CreateAgentDeps {
  storage: StorageAdapter;
  traceExporter: InMemoryExporter;
}

//#endregion

//#region Agent module loading

const HarnessSchema = z.custom<AgentHarness>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'execute' in value &&
    typeof value.execute === 'function',
  '`createAgent(deps)` must return `{ harness: AgentHarness }`.',
);

const AgentModuleSchema = z.object({
  createAgent: z.custom<
    (deps: CreateAgentDeps) => {
      harness: AgentHarness;
    }
  >(
    (value) => typeof value === 'function',
    'Agent file must export `createAgent(deps): { harness }`.',
  ),
});

async function loadAgent(agentFile: string, deps: CreateAgentDeps): Promise<AgentHarness> {
  const mod = AgentModuleSchema.parse(await import(agentFile));
  return HarnessSchema.parse(
    z
      .object({
        harness: z.unknown(),
      })
      .parse(mod.createAgent(deps)).harness,
  );
}

//#endregion

//#region Roster

function toLayerInfo(layer: ContextLayer): LayerInfo {
  return {
    id: layer.id,
    name: layer.name,
    slot: layer.slot,
    scope: layer.scope,
    budget: layer.budget,
  };
}

//#endregion

//#region Pumps

/** Live UI feed only — persistence happens once per turn from
 *  `HarnessResponse.items` (see the child's turn watcher), because this stream
 *  carries model output only and never the user's messages. */
async function pumpItems(boot: AgentBoot, threadId: string, hub: SseHub): Promise<void> {
  for await (const streamingItem of boot.harness.getItemStream({
    threadId,
  })) {
    hub.publish({
      type: 'item',
      item: streamingItem,
    });
  }
}

async function pumpEvents(boot: AgentBoot, threadId: string, hub: SseHub): Promise<void> {
  for await (const event of boot.harness.getFullStream({
    threadId,
  })) {
    // Framework lifecycle events are typed `${agentName}:${eventType}`; raw
    // SDK stream events (dot-separated) stay server-side — the UI streams
    // text through item frames instead.
    if (typeof event.type === 'string' && event.type.includes(':')) {
      hub.publish({
        type: 'event',
        event,
      });
    }
  }
}

//#endregion

//#region Boot

export async function bootAgent(cfg: ChildConfig, hub: SseHub): Promise<AgentBoot> {
  const storage = createFileStorage({
    root: path.join(cfg.dataDir, 'storage'),
  });
  const exporter = new InMemoryExporter();
  const harness = await loadAgent(cfg.agentFile, {
    storage,
    traceExporter: exporter,
  });

  let previewInFlight = false;
  const execIds = decorateLayerStateStore(harness.layerStateStore, {
    isSuppressed: () => previewInFlight,
    onChange: (event) => {
      hub.publish({
        type: 'layer_state',
        ...event,
      });
    },
  });

  const sessionStore = createJsonlSessionStore(path.join(cfg.dataDir, 'sessions'));
  seedFromItems(harness, cfg.threadId, await sessionStore.readItems(cfg.threadId));

  const boot: AgentBoot = {
    harness,
    exporter,
    storage,
    sessionStore,
    execIds,
    layers: (harness._contextLayers ?? []).map(toLayerInfo).sort((a, b) => a.slot - b.slot),
    async suppressed<T>(fn: () => Promise<T>): Promise<T> {
      previewInFlight = true;
      try {
        return await fn();
      } finally {
        previewInFlight = false;
      }
    },
  };

  void pumpItems(boot, cfg.threadId, hub).catch((err) => {
    console.error('[inspector] item pump failed:', err);
  });
  void pumpEvents(boot, cfg.threadId, hub).catch((err) => {
    console.error('[inspector] event pump failed:', err);
  });

  return boot;
}

//#endregion
