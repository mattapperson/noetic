/**
 * Storage store for managing storage metrics and actions
 * Handles storage usage tracking and deletion operations
 */

import { create } from 'zustand';
import { deserialize } from '../lib/serialization';
import type { AgentStorageInfo, StorageMetrics, StorageWarningLevel } from '../types/agent';

interface StorageState {
  // Storage metrics
  metrics: StorageMetrics;

  // Actions
  setMetrics: (metrics: StorageMetrics) => void;
  updateMetrics: (updates: Partial<StorageMetrics>) => void;
  updateAgentStorage: (agentId: string, info: AgentStorageInfo) => void;
  removeAgentStorage: (agentId: string) => void;
  clearAllStorage: () => void;

  // Getters
  getTotalUsagePercent: () => number;
  getWarningLevel: () => StorageWarningLevel;
  getFormattedTotalSize: () => string;
  getFormattedAvailable: () => string;
}

const INITIAL_METRICS: StorageMetrics = {
  totalRuns: 0,
  totalSizeBytes: 0,
  availableBytes: 1024 * 1024 * 1024 * 1024, // 1 TB default
  byAgent: new Map(),
};

export const useStorageStore = create<StorageState>()((set, get) => ({
  // Initial state
  metrics: INITIAL_METRICS,

  // Actions
  setMetrics: (metrics) =>
    set({
      // Deserialize to convert any serialized Maps back to Map instances
      metrics: deserialize(metrics),
    }),

  updateMetrics: (updates) =>
    set((state) => ({
      metrics: {
        ...state.metrics,
        ...updates,
      },
    })),

  updateAgentStorage: (agentId, info) =>
    set((state) => {
      const byAgent = new Map(state.metrics.byAgent);
      byAgent.set(agentId, info);

      // Recalculate totals
      let totalRuns = 0;
      let totalSizeBytes = 0;
      for (const agentInfo of byAgent.values()) {
        totalRuns += agentInfo.runCount;
        totalSizeBytes += agentInfo.sizeBytes;
      }

      return {
        metrics: {
          ...state.metrics,
          totalRuns,
          totalSizeBytes,
          byAgent,
        },
      };
    }),

  removeAgentStorage: (agentId) =>
    set((state) => {
      const byAgent = new Map(state.metrics.byAgent);
      const agentInfo = byAgent.get(agentId);

      if (agentInfo) {
        byAgent.delete(agentId);

        return {
          metrics: {
            ...state.metrics,
            totalRuns: state.metrics.totalRuns - agentInfo.runCount,
            totalSizeBytes: state.metrics.totalSizeBytes - agentInfo.sizeBytes,
            byAgent,
          },
        };
      }

      return state;
    }),

  clearAllStorage: () =>
    set((state) => ({
      metrics: {
        ...state.metrics,
        totalRuns: 0,
        totalSizeBytes: 0,
        byAgent: new Map(),
      },
    })),

  // Getters
  getTotalUsagePercent: () => {
    const { metrics } = get();
    const totalSpace = metrics.totalSizeBytes + metrics.availableBytes;
    if (totalSpace === 0) {
      return 0;
    }
    return (metrics.totalSizeBytes / totalSpace) * 100;
  },

  getWarningLevel: () => {
    const percentage = get().getTotalUsagePercent();

    if (percentage >= 95) {
      return {
        level: 'critical',
        percentage,
        message: 'Storage is critically full. Delete runs to free space.',
      };
    }
    if (percentage >= 80) {
      return {
        level: 'warning',
        percentage,
        message: 'Storage is filling up. Consider cleaning old runs.',
      };
    }
    return {
      level: 'normal',
      percentage,
    };
  },

  getFormattedTotalSize: () => {
    const bytes = get().metrics.totalSizeBytes;
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
  },

  getFormattedAvailable: () => {
    const bytes = get().metrics.availableBytes;
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
  },
}));
