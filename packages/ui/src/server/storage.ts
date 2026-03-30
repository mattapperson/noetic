/**
 * Storage module for Noetic UI
 *
 * Handles file-based persistence of execution traces in ~/.noetic-ui/traces/
 */

import { access, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ExecutionTrace, Run } from '../shared/protocol.js';

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

const nodeErrorSchema = z.object({
  code: z.string(),
});

const runSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  trace: z.object({}),
});

const serializedMapSchema = z.object({
  dataType: z.literal('Map'),
  value: z.array(
    z.tuple([
      z.string(),
      z.unknown(),
    ]),
  ),
});

// ============================================================================
// Type Guards using Zod
// ============================================================================

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return nodeErrorSchema.safeParse(error).success;
}

function isValidRun(value: unknown): value is Run {
  return runSchema.safeParse(value).success;
}

function isSerializedMap(value: unknown): value is {
  dataType: 'Map';
  value: [
    string,
    unknown,
  ][];
} {
  return serializedMapSchema.safeParse(value).success;
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_STORAGE_PATH = join(homedir(), '.noetic-ui', 'traces');
const STORAGE_PATH = process.env.NOETIC_UI_STORAGE_PATH || DEFAULT_STORAGE_PATH;

// Maximum steps per run (as per spec v1)
const MAX_STEPS_PER_RUN = 1000;
const WARNING_STEPS_THRESHOLD = 500;

// ============================================================================
// Types
// ============================================================================

export interface StorageMetrics {
  totalRuns: number;
  totalSizeBytes: number;
  availableBytes: number;
  byAgent: Map<
    string,
    {
      runCount: number;
      sizeBytes: number;
    }
  >;
}

export interface StorageWarning {
  type: 'step_warning' | 'step_limit_reached' | 'storage_full';
  message: string;
  runId: string;
}

export interface SaveResult {
  success: boolean;
  runId: string;
  warning?: StorageWarning;
  error?: string;
}

// ============================================================================
// Storage Manager
// ============================================================================

export class TraceStorage {
  private storagePath: string;
  private metrics: StorageMetrics | null = null;
  private metricsCacheTime = 0;
  private readonly METRICS_CACHE_MS = 5000; // Cache metrics for 5 seconds

  constructor(storagePath?: string) {
    this.storagePath = storagePath || STORAGE_PATH;
  }

  /**
   * Initialize storage directory
   */
  async init(): Promise<void> {
    await mkdir(this.storagePath, {
      recursive: true,
    });
  }

  /**
   * Save a trace to storage
   */
  async saveTrace(
    trace: ExecutionTrace,
    agentId: string,
    input: unknown,
    isLive = false,
  ): Promise<SaveResult> {
    const runId = trace.traceId;
    const nodeCount = trace.nodes.size;

    // Check for step limits
    let warning: StorageWarning | undefined;
    if (nodeCount >= MAX_STEPS_PER_RUN) {
      warning = {
        type: 'step_limit_reached',
        message: `Recording stopped at ${MAX_STEPS_PER_RUN} steps. Execution continues.`,
        runId,
      };
    } else if (nodeCount >= WARNING_STEPS_THRESHOLD) {
      warning = {
        type: 'step_warning',
        message: `This run has ${nodeCount} steps. Performance may degrade when viewing traces with many steps.`,
        runId,
      };
    }

    try {
      const run: Run = {
        id: runId,
        agentId,
        startTime: trace.startTime,
        endTime: trace.endTime,
        durationMs: trace.endTime ? trace.endTime - trace.startTime : null,
        status: trace.status,
        input,
        inputPreview: this.createInputPreview(input),
        trace,
        rootNodeId: trace.rootNodeId,
        timelineEvents: [], // Populated as execution progresses
        currentTimelinePosition: 0,
        totalSteps: nodeCount,
        totalTokens: {
          input: 0,
          output: 0,
          total: 0,
        },
        totalCost: 0,
        maxDepth: this.calculateMaxDepth(trace),
        memoryBytes: 0,
        maxMemoryBytes: 0,
        recordingVersion: '1.0',
        isLive,
        breakpointsHit: [],
        pauseHistory: [],
      };

      const filePath = this.getRunFilePath(agentId, runId);
      const agentDir = join(this.storagePath, agentId);
      await mkdir(agentDir, {
        recursive: true,
      });

      const serialized = JSON.stringify(run, this.replacer, 2);
      await writeFile(filePath, serialized, 'utf-8');

      // Invalidate metrics cache
      this.metricsCacheTime = 0;

      return {
        success: true,
        runId,
        warning,
      };
    } catch (error) {
      console.error('[Storage] Failed to save run:', error);
      return {
        success: false,
        runId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Load a run from storage
   */
  async loadRun(agentId: string, runId: string): Promise<Run | null> {
    try {
      const filePath = this.getRunFilePath(agentId, runId);
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content, this.reviver);
      if (!isValidRun(parsed)) {
        console.error(`[Storage] Invalid run data loaded for ${agentId}/${runId}`);
        return null;
      }
      return parsed;
    } catch (error) {
      if (!isNodeError(error)) {
        console.error(`[Storage] Failed to load run ${agentId}/${runId}:`, error);
        throw error;
      }
      if (error.code === 'ENOENT') {
        return null;
      }
      console.error(`[Storage] Failed to load run ${agentId}/${runId}:`, error);
      throw error;
    }
  }

  /**
   * Update an existing run (for live execution updates)
   */
  async updateRun(agentId: string, run: Run): Promise<void> {
    const filePath = this.getRunFilePath(agentId, run.id);
    const serialized = JSON.stringify(run, this.replacer, 2);
    await writeFile(filePath, serialized, 'utf-8');
    this.metricsCacheTime = 0;
  }

  /**
   * Delete a specific run
   */
  async deleteRun(agentId: string, runId: string): Promise<boolean> {
    try {
      const filePath = this.getRunFilePath(agentId, runId);
      await unlink(filePath);
      this.metricsCacheTime = 0;
      return true;
    } catch (error) {
      if (!isNodeError(error)) {
        console.error(`[Storage] Failed to delete run ${agentId}/${runId}:`, error);
        throw error;
      }
      if (error.code === 'ENOENT') {
        return false;
      }
      console.error(`[Storage] Failed to delete run ${agentId}/${runId}:`, error);
      throw error;
    }
  }

  /**
   * Delete all runs for an agent
   */
  async deleteAgentRuns(agentId: string): Promise<number> {
    const runs = await this.listAgentRuns(agentId);
    let deletedCount = 0;

    for (const run of runs) {
      const success = await this.deleteRun(agentId, run.id);
      if (success) {
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * List all runs for an agent
   */
  async listAgentRuns(agentId: string): Promise<Run[]> {
    try {
      const agentDir = join(this.storagePath, agentId);
      await access(agentDir);

      const files = await readdir(agentDir);
      const runs: Run[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const runId = file.replace('.json', '');
          const run = await this.loadRun(agentId, runId);
          if (run) {
            runs.push(run);
          }
        }
      }

      // Sort by start time, newest first
      return runs.sort((a, b) => b.startTime - a.startTime);
    } catch (error) {
      console.error('[Storage] Failed to list runs for agent:', agentId, error);
      return [];
    }
  }

  /**
   * List all agent IDs with stored runs
   */
  async listAgents(): Promise<string[]> {
    try {
      const entries = await readdir(this.storagePath, {
        withFileTypes: true,
      });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      console.error('[Storage] Failed to list agents:', error);
      return [];
    }
  }

  /**
   * Get storage metrics
   */
  async getMetrics(): Promise<StorageMetrics> {
    const now = Date.now();
    if (this.metrics && now - this.metricsCacheTime < this.METRICS_CACHE_MS) {
      return this.metrics;
    }

    const agents = await this.listAgents();
    let totalSize = 0;
    const byAgent = new Map<
      string,
      {
        runCount: number;
        sizeBytes: number;
      }
    >();

    for (const agentId of agents) {
      const runs = await this.listAgentRuns(agentId);
      let agentSize = 0;

      for (const run of runs) {
        const filePath = this.getRunFilePath(agentId, run.id);
        try {
          const stats = await stat(filePath);
          agentSize += stats.size;
        } catch (error) {
          // File might be deleted or not accessible
          console.debug(`[Storage] Could not stat file ${filePath}:`, error);
        }
      }

      totalSize += agentSize;
      byAgent.set(agentId, {
        runCount: runs.length,
        sizeBytes: agentSize,
      });
    }

    this.metrics = {
      totalRuns: Array.from(byAgent.values()).reduce((sum, a) => sum + a.runCount, 0),
      totalSizeBytes: totalSize,
      availableBytes: 0, // Not implemented for v1
      byAgent,
    };
    this.metricsCacheTime = now;

    return this.metrics;
  }

  /**
   * Clear all stored traces
   */
  async clearAll(): Promise<void> {
    const agents = await this.listAgents();
    for (const agentId of agents) {
      await this.deleteAgentRuns(agentId);
    }
    this.metricsCacheTime = 0;
  }

  /**
   * Get storage path
   */
  getStoragePath(): string {
    return this.storagePath;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private getRunFilePath(agentId: string, runId: string): string {
    return join(this.storagePath, agentId, `${runId}.json`);
  }

  private createInputPreview(input: unknown): string {
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    return str.length > 50 ? str.slice(0, 50) + '...' : str;
  }

  private calculateMaxDepth(trace: ExecutionTrace): number {
    let maxDepth = 0;
    for (const node of trace.nodes.values()) {
      if (node.depth > maxDepth) {
        maxDepth = node.depth;
      }
    }
    return maxDepth;
  }

  // JSON replacer for serializing Maps
  private replacer(_key: string, value: unknown): unknown {
    if (value instanceof Map) {
      return {
        dataType: 'Map',
        value: Array.from(value.entries()),
      };
    }
    return value;
  }

  // JSON reviver for deserializing Maps
  private reviver(_key: string, value: unknown): unknown {
    if (isSerializedMap(value)) {
      return new Map(value.value);
    }
    return value;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalStorage: TraceStorage | null = null;

export function getStorage(storagePath?: string): TraceStorage {
  if (!globalStorage) {
    globalStorage = new TraceStorage(storagePath);
  }
  return globalStorage;
}

export function resetStorage(): void {
  globalStorage = null;
}
