/**
 * Storage module for Noetic UI
 *
 * Handles file-based persistence of execution traces.
 * By default, stores data in the project's .noetic/ui/ directory.
 * Falls back to ~/.noetic-ui/traces/ if no project root is found.
 */

import {
  access,
  constants,
  mkdir,
  readdir,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { cwd } from 'node:process';
import { z } from 'zod';
import type { ExecutionTrace, Run } from '../shared/protocol.js';

// ============================================================================
// Project Root Detection
// ============================================================================

/**
 * Detect the project root directory by looking for package.json
 * starting from the current working directory and walking up.
 */
async function detectProjectRoot(): Promise<string | null> {
  const startTime = Date.now();
  let currentDir = cwd();
  const maxIterations = 20; // Prevent infinite loop

  for (let i = 0; i < maxIterations; i++) {
    try {
      // Check if package.json exists in current directory
      const packageJsonPath = join(currentDir, 'package.json');
      await access(packageJsonPath, constants.R_OK);

      // Verify it's a valid package.json
      const content = await readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);

      // Found a valid project root
      if (pkg.name) {
        console.log(
          `[Storage] detectProjectRoot: found at ${currentDir} in ${Date.now() - startTime}ms after ${i + 1} iterations`,
        );
        return currentDir;
      }
    } catch {
      // package.json not found or not readable, try parent
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Reached filesystem root
    }
    currentDir = parentDir;
  }

  console.log(`[Storage] detectProjectRoot: not found after ${Date.now() - startTime}ms`);
  return null;
}

/**
 * Get the default storage path.
 * Uses project directory if found, otherwise falls back to home directory.
 */
async function getDefaultStoragePath(): Promise<string> {
  const startTime = Date.now();
  // Check if explicit path is set via environment
  if (process.env.NOETIC_UI_STORAGE_PATH) {
    console.log(`[Storage] getDefaultStoragePath: using env var in ${Date.now() - startTime}ms`);
    return process.env.NOETIC_UI_STORAGE_PATH;
  }

  // Try to detect project root
  const detectStart = Date.now();
  const projectRoot = await detectProjectRoot();
  console.log(`[Storage] detectProjectRoot took ${Date.now() - detectStart}ms`);

  if (projectRoot) {
    const result = join(projectRoot, '.noetic', 'ui', 'traces');
    console.log(
      `[Storage] getDefaultStoragePath: project root found in ${Date.now() - startTime}ms`,
    );
    return result;
  }

  // Fall back to home directory
  const homeResult = join(homedir(), '.noetic-ui', 'traces');
  console.log(`[Storage] getDefaultStoragePath: fallback to home in ${Date.now() - startTime}ms`);
  return homeResult;
}

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

// Agents registry file path (stored at storage root, not in traces subdir)
const AGENTS_REGISTRY_FILE = 'agents.json';

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
  private storagePath: string | null = null;
  private providedPath: string | undefined;
  private metrics: StorageMetrics | null = null;
  private metricsCacheTime = 0;
  private readonly METRICS_CACHE_MS = 5000; // Cache metrics for 5 seconds
  private registeredAgents = new Map<
    string,
    {
      name: string;
      registeredAt: number;
    }
  >();
  private agentsLoaded = false;
  private agentsLoadingPromise: Promise<void> | null = null;

  constructor(storagePath?: string) {
    this.providedPath = storagePath;
  }

  /**
   * Get the resolved storage path
   */
  private async getResolvedStoragePath(): Promise<string> {
    if (this.storagePath) {
      return this.storagePath;
    }

    if (this.providedPath) {
      this.storagePath = this.providedPath;
      return this.storagePath;
    }

    // Resolve default path (project-based or home directory)
    this.storagePath = await getDefaultStoragePath();
    return this.storagePath;
  }

  /**
   * Initialize storage directory and load registered agents
   */
  async init(): Promise<void> {
    const path = await this.getResolvedStoragePath();
    await mkdir(path, {
      recursive: true,
    });

    // Load registered agents from disk
    await this.loadRegisteredAgents();
  }

  /**
   * Register an agent (called when agent connects via WebSocket)
   */
  async registerAgent(agentId: string, agentName: string): Promise<void> {
    // Ensure agents are loaded before registering (with race condition protection)
    if (!this.agentsLoaded) {
      if (this.agentsLoadingPromise) {
        await this.agentsLoadingPromise;
      } else {
        this.agentsLoadingPromise = this.loadRegisteredAgents();
        await this.agentsLoadingPromise;
        this.agentsLoadingPromise = null;
      }
    }

    this.registeredAgents.set(agentId, {
      name: agentName,
      registeredAt: Date.now(),
    });

    // Persist to disk
    await this.saveRegisteredAgents();
  }

  /**
   * Unregister/delete an agent (removes from memory and disk)
   */
  async unregisterAgent(agentId: string): Promise<boolean> {
    // Ensure agents are loaded (with race condition protection)
    if (!this.agentsLoaded) {
      if (this.agentsLoadingPromise) {
        await this.agentsLoadingPromise;
      } else {
        this.agentsLoadingPromise = this.loadRegisteredAgents();
        await this.agentsLoadingPromise;
        this.agentsLoadingPromise = null;
      }
    }

    const existed = this.registeredAgents.has(agentId);
    this.registeredAgents.delete(agentId);

    // Persist deletion to disk
    await this.saveRegisteredAgents();

    return existed;
  }

  /**
   * Load registered agents from disk
   */
  private async loadRegisteredAgents(): Promise<void> {
    const startTime = Date.now();
    try {
      const filePath = await this.getAgentsFilePath();
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      if (parsed && typeof parsed === 'object') {
        for (const [agentId, agentData] of Object.entries(parsed)) {
          if (agentData && typeof agentData === 'object') {
            this.registeredAgents.set(agentId, {
              name:
                (
                  agentData as {
                    name?: string;
                  }
                ).name || 'Unknown',
              registeredAt:
                (
                  agentData as {
                    registeredAt?: number;
                  }
                ).registeredAt || Date.now(),
            });
          }
        }
      }

      this.agentsLoaded = true;
      console.log(
        `[Storage] loadRegisteredAgents: loaded ${this.registeredAgents.size} agents in ${Date.now() - startTime}ms`,
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        console.error('[Storage] Failed to load registered agents:', error);
      }
      // File doesn't exist yet - that's ok, start with empty map
      this.agentsLoaded = true;
      console.log(
        `[Storage] loadRegisteredAgents: no file found, loaded 0 agents in ${Date.now() - startTime}ms`,
      );
    }
  }

  /**
   * Save registered agents to disk
   */
  private async saveRegisteredAgents(): Promise<void> {
    try {
      // Convert Map to plain object for JSON serialization
      const agentsObj: Record<
        string,
        {
          name: string;
          registeredAt: number;
        }
      > = {};
      for (const [agentId, agentData] of this.registeredAgents) {
        agentsObj[agentId] = agentData;
      }

      const filePath = await this.getAgentsFilePath();
      await writeFile(filePath, JSON.stringify(agentsObj, null, 2), 'utf-8');
    } catch (error) {
      console.error('[Storage] Failed to save registered agents:', error);
    }
  }

  /**
   * Get the path to the agents registry file
   */
  private async getAgentsFilePath(): Promise<string> {
    const storagePath = await this.getResolvedStoragePath();
    // Store agents.json at the parent of traces directory (storage root)
    return join(dirname(storagePath), AGENTS_REGISTRY_FILE);
  }

  /**
   * Get list of registered agent IDs (ensures agents are loaded)
   */
  async getRegisteredAgents(): Promise<string[]> {
    if (this.agentsLoaded) {
      return Array.from(this.registeredAgents.keys());
    }

    // Prevent race condition: if already loading, wait for that promise
    if (this.agentsLoadingPromise) {
      await this.agentsLoadingPromise;
      return Array.from(this.registeredAgents.keys());
    }

    // Start loading and store the promise
    this.agentsLoadingPromise = this.loadRegisteredAgents();
    await this.agentsLoadingPromise;
    this.agentsLoadingPromise = null;

    return Array.from(this.registeredAgents.keys());
  }

  /**
   * Get full info for all registered agents
   */
  async getRegisteredAgentInfo(): Promise<
    Map<
      string,
      {
        name: string;
        registeredAt: number;
      }
    >
  > {
    if (this.agentsLoaded) {
      return new Map(this.registeredAgents);
    }

    // Prevent race condition: if already loading, wait for that promise
    if (this.agentsLoadingPromise) {
      await this.agentsLoadingPromise;
      return new Map(this.registeredAgents);
    }

    // Start loading and store the promise
    this.agentsLoadingPromise = this.loadRegisteredAgents();
    await this.agentsLoadingPromise;
    this.agentsLoadingPromise = null;

    return new Map(this.registeredAgents);
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
      // Calculate aggregated stats from all nodes in the trace
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCostValue = 0;

      for (const node of trace.nodes.values()) {
        if (node.contextSnapshot) {
          totalInputTokens += node.contextSnapshot.tokens?.input ?? 0;
          totalOutputTokens += node.contextSnapshot.tokens?.output ?? 0;
          totalCostValue += node.contextSnapshot.cost ?? 0;
        }
      }

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
          input: totalInputTokens,
          output: totalOutputTokens,
          total: totalInputTokens + totalOutputTokens,
        },
        totalCost: totalCostValue,
        maxDepth: this.calculateMaxDepth(trace),
        memoryBytes: 0,
        maxMemoryBytes: 0,
        recordingVersion: '1.0',
        isLive,
        breakpointsHit: [],
        pauseHistory: [],
      };

      const filePath = await this.getRunFilePath(agentId, runId);
      const storagePath = await this.getResolvedStoragePath();
      const agentDir = join(storagePath, agentId);
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
      const filePath = await this.getRunFilePath(agentId, runId);
      const content = await readFile(filePath, 'utf-8');

      // Strip trailing null bytes (0x00) that can corrupt JSON files
      const cleanContent = content.replace(/\x00+$/, '');

      // Check if file is empty after cleaning
      if (!cleanContent || cleanContent.trim().length === 0) {
        console.error(`[Storage] Empty run file for ${agentId}/${runId}`);
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleanContent, this.reviver);
      } catch (parseError) {
        console.error(`[Storage] JSON parse error for ${agentId}/${runId}:`, parseError);
        console.error(
          '[Storage] File content preview (first 200 chars):',
          cleanContent.substring(0, 200),
        );
        return null;
      }

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
   * Load run metadata only (without full trace data)
   * Much faster than loadRun() for listing operations
   */
  async loadRunMetadata(agentId: string, runId: string): Promise<Run | null> {
    const startTime = Date.now();
    try {
      const filePath = await this.getRunFilePath(agentId, runId);
      const content = await readFile(filePath, 'utf-8');

      // Strip trailing null bytes (0x00) that can corrupt JSON files
      const cleanContent = content.replace(/\x00+$/, '');

      // Use a reviver that skips the trace field to avoid parsing massive trace data
      const metadataReviver = (key: string, value: unknown): unknown => {
        // Skip trace field entirely - don't parse it
        if (key === 'trace') {
          return undefined;
        }
        // Handle Maps for other fields
        if (isSerializedMap(value)) {
          return new Map(value.value);
        }
        return value;
      };

      const parsed = JSON.parse(cleanContent, metadataReviver);

      // Validate required fields exist (lightweight check)
      if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || !('agentId' in parsed)) {
        console.error(`[Storage] Invalid run metadata for ${agentId}/${runId}`);
        return null;
      }

      const duration = Date.now() - startTime;
      console.log(`[Storage] loadRunMetadata(${agentId}/${runId}): ${duration}ms`);
      return parsed as Run;
    } catch (error) {
      if (!isNodeError(error)) {
        console.error(`[Storage] Failed to load run metadata ${agentId}/${runId}:`, error);
        throw error;
      }
      if (error.code === 'ENOENT') {
        return null;
      }
      console.error(`[Storage] Failed to load run metadata ${agentId}/${runId}:`, error);
      throw error;
    }
  }

  /**
   * Update an existing run (for live execution updates)
   */
  async updateRun(agentId: string, run: Run): Promise<void> {
    const filePath = await this.getRunFilePath(agentId, run.id);
    const serialized = JSON.stringify(run, this.replacer, 2);
    await writeFile(filePath, serialized, 'utf-8');
    this.metricsCacheTime = 0;
  }

  /**
   * Delete a specific run
   */
  async deleteRun(agentId: string, runId: string): Promise<boolean> {
    try {
      const filePath = await this.getRunFilePath(agentId, runId);
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
   * Delete agent directory after all runs are deleted
   */
  async deleteAgentDirectory(agentId: string): Promise<boolean> {
    try {
      const storagePath = await this.getResolvedStoragePath();
      const agentDir = join(storagePath, agentId);
      await rmdir(agentDir);
      return true;
    } catch (error) {
      // Directory might not exist or might not be empty
      return false;
    }
  }

  /**
   * List all runs for an agent
   * Uses loadRunMetadata() for better performance on large traces
   */
  async listAgentRuns(agentId: string): Promise<Run[]> {
    const startTime = Date.now();
    try {
      const storagePath = await this.getResolvedStoragePath();
      const agentDir = join(storagePath, agentId);
      await access(agentDir);

      const files = await readdir(agentDir);
      const runs: Run[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const runId = file.replace('.json', '');
          // Use loadRunMetadata for faster loading (skips trace data)
          const run = await this.loadRunMetadata(agentId, runId);
          if (run) {
            runs.push(run);
          }
        }
      }

      // Sort by start time, newest first
      const result = runs.sort((a, b) => b.startTime - a.startTime);
      const duration = Date.now() - startTime;
      console.log(`[Storage] listAgentRuns(${agentId}): ${runs.length} runs in ${duration}ms`);
      return result;
    } catch (error) {
      // Silently return empty array if directory doesn't exist (agent has no runs yet)
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      // Only log actual errors, not "directory doesn't exist"
      console.error('[Storage] Failed to list runs for agent:', agentId, error);
      return [];
    }
  }

  /**
   * List all agent IDs with stored runs OR registered agents
   */
  async listAgents(): Promise<string[]> {
    const startTime = Date.now();
    try {
      // Get agents with stored traces
      const storagePathStart = Date.now();
      const storagePath = await this.getResolvedStoragePath();
      console.log(
        `[Storage] listAgents: storage path resolved in ${Date.now() - storagePathStart}ms`,
      );

      const readdirStart = Date.now();
      const entries = await readdir(storagePath, {
        withFileTypes: true,
      });
      console.log(
        `[Storage] listAgents: readdir took ${Date.now() - readdirStart}ms, found ${entries.length} entries`,
      );

      const storedAgents = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      console.log(`[Storage] listAgents: ${storedAgents.length} stored agents`);

      // Get registered agents (from connected agents without traces yet)
      const registeredStart = Date.now();
      const registeredAgents = await this.getRegisteredAgents();
      console.log(
        `[Storage] listAgents: getRegisteredAgents took ${Date.now() - registeredStart}ms, found ${registeredAgents.length} registered`,
      );

      // Combine and deduplicate
      const allAgents = new Set([
        ...storedAgents,
        ...registeredAgents,
      ]);
      const result = Array.from(allAgents);
      const duration = Date.now() - startTime;
      console.log(`[Storage] listAgents: TOTAL ${duration}ms, returning ${result.length} agents`);
      return result;
    } catch (error) {
      console.error('[Storage] Failed to list agents:', error);
      // Return registered agents even if storage fails
      return this.getRegisteredAgents();
    }
  }

  /**
   * Get storage metrics
   * Optimized to use stat() instead of loading run data
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
      let agentSize = 0;
      let runCount = 0;

      try {
        const storagePath = await this.getResolvedStoragePath();
        const agentDir = join(storagePath, agentId);

        // Just count files and get sizes without parsing JSON
        const files = await readdir(agentDir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const filePath = join(agentDir, file);
            try {
              const stats = await stat(filePath);
              agentSize += stats.size;
              runCount++;
            } catch (error) {
              // File might be deleted or not accessible
              console.debug(`[Storage] Could not stat file ${filePath}:`, error);
            }
          }
        }
      } catch (error) {
        // Agent directory might not exist
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          console.debug(`[Storage] Could not read agent directory ${agentId}:`, error);
        }
      }

      totalSize += agentSize;
      byAgent.set(agentId, {
        runCount,
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
  async getStoragePath(): Promise<string> {
    return await this.getResolvedStoragePath();
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private async getRunFilePath(agentId: string, runId: string): Promise<string> {
    const storagePath = await this.getResolvedStoragePath();
    return join(storagePath, agentId, `${runId}.json`);
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
    // Fast path: check for Map serialization without Zod
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'dataType' in value &&
      value.dataType === 'Map' &&
      'value' in value &&
      Array.isArray(value.value)
    ) {
      return new Map(
        (
          value as {
            value: [
              string,
              unknown,
            ][];
          }
        ).value,
      );
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
