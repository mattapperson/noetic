/**
 * SSE consumption: one hook per stream (agent child, host lifecycle), both
 * writing into the zustand store. `EventSource` auto-reconnects through child
 * restarts (the host proxy 503s while the child is down); every (re)open
 * refetches the snapshot endpoints so missed frames can't leave stale state.
 */

'use client';

import { useEffect } from 'react';
import { z } from 'zod';
import type {
  ConsoleLine,
  ForwardedEvent,
  HostEvent,
  LastLayerUsage,
  StreamingItem,
} from '../server/wire-types';
import { api, HOST } from './api';
import { useInspector } from './store';

//#region Frame parsing

// Envelope-level validation only: payloads are produced by our own server
// from types shared through wire-types.ts, so re-validating their internals
// in the browser would just duplicate core's schemas.
const AgentFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('item'),
    item: z.custom<StreamingItem>(() => true),
  }),
  z.object({
    type: z.literal('event'),
    event: z.custom<ForwardedEvent>(() => true),
  }),
  z.object({
    type: z.literal('layer_state'),
    layerId: z.string(),
  }),
  z.object({
    type: z.literal('layer_usage'),
    usage: z.custom<LastLayerUsage>(() => true),
  }),
  z.object({
    type: z.literal('preview_invalidated'),
  }),
]);

const HostFrameSchema = z.union([
  z.custom<HostEvent>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      value.type === 'child_status',
  ),
  z.object({
    type: z.literal('console_line'),
    line: z.custom<ConsoleLine>(() => true),
  }),
]);

//#endregion

//#region Refetch

/** Reconcile after any gap in the stream (connect, reconnect, child_ready). */
async function refetchAgentData(): Promise<void> {
  const store = useInspector.getState();
  const results = await Promise.allSettled([
    api.history(),
    api.layers(),
    api.usage(),
    api.status(),
  ]);
  const [history, layers, usage, status] = results;
  if (history.status === 'fulfilled') {
    store.setHistory(
      history.value.items.map((item) => ({
        ...item,
        isComplete: true,
      })),
    );
  }
  if (layers.status === 'fulfilled') {
    store.setLayers(layers.value);
  }
  if (usage.status === 'fulfilled') {
    store.setUsage(usage.value);
  }
  if (status.status === 'fulfilled') {
    // A draining turn is still running: it stops only once its drain ends.
    store.setGenerating(status.value.kind === 'generating' || status.value.kind === 'draining');
  }
  // A gap may span a whole turn (or a reset) — recompute the preview too.
  store.invalidatePreview();
}

//#endregion

//#region Frame handlers

function handleAgentFrame(frame: z.infer<typeof AgentFrameSchema>): void {
  const store = useInspector.getState();
  switch (frame.type) {
    case 'item':
      store.upsertItem(frame.item);
      return;
    case 'event': {
      store.pushEvent(frame.event);
      const eventType = frame.event.type.split(':').pop();
      if (eventType === 'turn_started') {
        store.setGenerating(true);
      }
      if (eventType === 'turn_completed' || eventType === 'turn_aborted') {
        store.setGenerating(false);
      }
      return;
    }
    case 'layer_state':
      store.bumpLayer(frame.layerId);
      return;
    case 'layer_usage':
      store.setUsage(frame.usage);
      return;
    case 'preview_invalidated':
      store.invalidatePreview();
      return;
  }
}

//#endregion

//#region Hooks

export function useAgentStream(): void {
  useEffect(() => {
    const source = new EventSource(`${HOST}/api/agent/stream`);
    source.onopen = () => {
      void refetchAgentData();
    };
    source.onmessage = (message) => {
      const parsed = AgentFrameSchema.safeParse(JSON.parse(message.data));
      if (parsed.success) {
        handleAgentFrame(parsed.data);
      }
    };
    return () => source.close();
  }, []);
}

export function useHostEvents(): void {
  useEffect(() => {
    void api
      .hostStatus()
      .then((host) => useInspector.getState().setHost(host))
      .catch(() => undefined);
    void api
      .consoleLines()
      .then(({ lines }) => useInspector.getState().setConsoleLines(lines))
      .catch(() => undefined);

    const source = new EventSource(`${HOST}/api/host/events`);
    source.onmessage = (message) => {
      const parsed = HostFrameSchema.safeParse(JSON.parse(message.data));
      if (!parsed.success) {
        return;
      }
      if (parsed.data.type === 'console_line') {
        useInspector.getState().pushConsoleLine(parsed.data.line);
        return;
      }
      useInspector.getState().setHost(parsed.data);
      // A fresh child seeded itself from disk — re-sync everything.
      if (parsed.data.child === 'ready') {
        void refetchAgentData();
      }
    };
    return () => source.close();
  }, []);
}

//#endregion
