'use client';

/**
 * Hook to load historical agent runs from the REST API on startup.
 * Fetches agents and their runs from the REST API on port 3334.
 */

import { useEffect } from 'react';
import { z } from 'zod';
import { useAgentStore } from '../stores/agent';

function getApiBase(): string {
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3334`;
  }
  return 'http://localhost:3334';
}

//#region Zod Schemas

const AgentIdsResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(z.string()).optional(),
});

const TokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  total: z.number(),
});

const TimelineEventSchema = z.object({
  timestamp: z.number(),
  nodeId: z.string(),
  type: z.enum([
    'start',
    'complete',
    'error',
    'pause',
    'data',
  ]),
  data: z.unknown().optional(),
});

const PausePointSchema = z.object({
  timestamp: z.number(),
  nodeId: z.string(),
  reason: z.enum([
    'breakpoint',
    'step',
    'error',
  ]),
  resumedAt: z.number().optional(),
});

const RunSummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  startTime: z.number(),
  endTime: z.number().nullable(),
  durationMs: z.number().nullable(),
  status: z.enum([
    'running',
    'completed',
    'error',
    'paused',
    'cancelled',
  ]),
  input: z.unknown(),
  inputPreview: z.string(),
  rootNodeId: z.string(),
  timelineEvents: z.array(TimelineEventSchema),
  currentTimelinePosition: z.number(),
  totalSteps: z.number(),
  totalTokens: TokenUsageSchema,
  totalCost: z.number(),
  maxDepth: z.number(),
  memoryBytes: z.number(),
  maxMemoryBytes: z.number(),
  recordingVersion: z.string(),
  isLive: z.boolean(),
  breakpointsHit: z.array(z.string()),
  pauseHistory: z.array(PausePointSchema),
  // trace is not included in REST summaries; full trace is fetched on demand
});

const RunsResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(RunSummarySchema).optional(),
});

// RunSummary omits trace — it is an optional field on Run so this is assignable
type RunSummary = z.infer<typeof RunSummarySchema>;

//#endregion

//#region Fetch Helpers

async function fetchAgentIds(base: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${base}/api/agents`);
    if (!res.ok) {
      return null;
    }
    const parsed = AgentIdsResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.success) {
      return null;
    }
    return parsed.data.data ?? null;
  } catch {
    return null;
  }
}

async function fetchRuns(base: string, agentId: string): Promise<RunSummary[] | null> {
  try {
    const res = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/runs`);
    if (!res.ok) {
      return null;
    }
    const parsed = RunsResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.success) {
      return null;
    }
    return parsed.data.data ?? null;
  } catch {
    return null;
  }
}

//#endregion

//#region Hook

export function useHistoricalRuns(): void {
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    async function loadHistory(): Promise<void> {
      useAgentStore.getState().setLoadingHistory(true);

      try {
        const base = getApiBase();
        const agentIds = await fetchAgentIds(base);
        if (!agentIds) {
          return;
        }

        for (const agentId of agentIds) {
          // Ensure agent exists in store
          const exists = useAgentStore.getState().agents.some((a) => a.id === agentId);
          if (!exists) {
            useAgentStore.getState().addAgent({
              id: agentId,
              name: agentId,
              filePath: '',
              exportName: '',
              discoveredAt: Date.now(),
              lastModified: Date.now(),
              discoveryMethod: 'runtime',
              runs: [],
              runCount: 0,
              lastRunAt: null,
            });
          }

          // Load run summaries
          const runs = await fetchRuns(base, agentId);
          if (!runs) {
            continue;
          }

          for (const run of runs) {
            useAgentStore.getState().addRun(agentId, run);
          }
        }
      } finally {
        useAgentStore.getState().setLoadingHistory(false);
      }
    }

    void loadHistory();
    // Only run on mount
  }, []);
}

//#endregion
