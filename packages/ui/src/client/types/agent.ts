/**
 * Agent and Run types for Noetic UI
 * Based on spec sections from 21-noetic-ui.md
 */

import type { ExecutionTrace, RunStatus, TimelineEvent } from '../../shared/protocol';

// ============================================================================
// Agent Types
// ============================================================================

export type AgentDiscoveryMethod = 'static' | 'manual' | 'runtime';

export interface Agent {
  id: string;
  name: string;
  filePath: string;
  exportName: string;

  // Discovery metadata
  discoveredAt: number;
  lastModified: number;
  discoveryMethod: AgentDiscoveryMethod;

  // Execution tracking
  runs: Run[];
  runCount: number;
  lastRunAt: number | null;

  // Configuration (optional)
  description?: string;
  tags?: string[];
}

export interface DiscoveredAgent {
  id: string;
  filePath: string;
  exportName: string;
  variableName?: string;
  name: string;
  description?: string;
  discoveredAt: number;
  discoveryMethod: 'static';
}

export interface RegisteredAgent {
  id: string;
  filePath: string;
  name: string;
  description?: string;
  harness?: unknown;
}

// ============================================================================
// Run Types
// ============================================================================

export interface Run {
  id: string;
  agentId: string;

  // Timing
  startTime: number;
  endTime: number | null;
  durationMs: number | null;

  // Status
  status: RunStatus;

  // Input
  input: unknown;
  inputPreview: string;

  // Execution data
  trace?: ExecutionTrace;
  rootNodeId: string;

  // Timeline data (for scrubbing)
  timelineEvents: TimelineEvent[];
  currentTimelinePosition: number;

  // Aggregated metrics
  totalSteps: number;
  totalTokens: {
    input: number;
    output: number;
    total: number;
  };
  totalCost: number;
  maxDepth: number;

  // Memory tracking
  memoryBytes: number;
  maxMemoryBytes: number;

  // Recording metadata
  recordingVersion: string;
  isLive: boolean;

  // Debugging
  breakpointsHit: string[];
  pauseHistory: PausePoint[];
}

export interface PausePoint {
  timestamp: number;
  nodeId: string;
  reason: 'breakpoint' | 'step' | 'error';
  resumedAt?: number;
}

// ============================================================================
// Storage Types
// ============================================================================

export interface StorageMetrics {
  totalRuns: number;
  totalSizeBytes: number;
  availableBytes: number;
  byAgent: Map<string, AgentStorageInfo>;
}

export interface AgentStorageInfo {
  runCount: number;
  sizeBytes: number;
}

export interface StorageWarningLevel {
  level: 'normal' | 'warning' | 'critical';
  percentage: number;
  message?: string;
}

// ============================================================================
// Search and Filter Types
// ============================================================================

export type AgentSortOption = 'recent' | 'oldest' | 'name' | 'runs';
export type RunSortOption = 'recent' | 'oldest' | 'duration' | 'cost' | 'memory';

export interface AgentFilter {
  searchQuery: string;
  tags?: string[];
  hasRuns?: boolean;
}

export interface RunFilter {
  searchQuery: string;
  statuses?: RunStatus[];
  dateRange?: {
    start: number;
    end: number;
  };
}

// ============================================================================
// Memory Indicator Types
// ============================================================================

export type MemoryLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface MemoryIndicator {
  bytes: number;
  level: MemoryLevel;
  label: string;
}

export const MEMORY_THRESHOLDS = {
  green: 50 * 1024 * 1024, // < 50 MB
  yellow: 200 * 1024 * 1024, // 50-200 MB
  orange: 500 * 1024 * 1024, // 200-500 MB
} as const;

export function getMemoryLevel(bytes: number): MemoryLevel {
  if (bytes < MEMORY_THRESHOLDS.green) {
    return 'green';
  }
  if (bytes < MEMORY_THRESHOLDS.yellow) {
    return 'yellow';
  }
  if (bytes < MEMORY_THRESHOLDS.orange) {
    return 'orange';
  }
  return 'red';
}

export function formatMemory(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getMemoryColor(level: MemoryLevel): string {
  const colors: Record<MemoryLevel, string> = {
    green: '#10b981', // emerald-500
    yellow: '#f59e0b', // amber-500
    orange: '#f97316', // orange-500
    red: '#ef4444', // red-500
  };
  return colors[level];
}
