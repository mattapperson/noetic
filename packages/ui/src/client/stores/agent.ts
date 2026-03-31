/**
 * Agent store for managing agent state
 * Handles agent discovery, selection, and run management
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Agent,
  AgentFilter,
  AgentSortOption,
  DiscoveredAgent,
  RegisteredAgent,
  Run,
  RunFilter,
  RunSortOption,
} from '../types/agent';

interface AgentState {
  // Agents
  agents: Agent[];
  selectedAgentId: string | null;
  expandedAgentIds: Set<string>;

  // Discovery
  discoveredAgents: DiscoveredAgent[];
  registeredAgents: RegisteredAgent[];
  lastDiscoveryTime: number | null;
  isDiscovering: boolean;

  // Filtering and sorting
  agentFilter: AgentFilter;
  agentSort: AgentSortOption;
  runFilter: RunFilter;
  runSort: RunSortOption;

  // Actions
  setAgents: (agents: Agent[]) => void;
  addAgent: (agent: Agent) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  removeAgent: (id: string) => void;

  selectAgent: (id: string | null) => void;
  toggleAgentExpanded: (id: string) => void;
  expandAgent: (id: string) => void;
  collapseAgent: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;

  setDiscoveredAgents: (agents: DiscoveredAgent[]) => void;
  addDiscoveredAgent: (agent: DiscoveredAgent) => void;
  registerAgent: (agent: RegisteredAgent) => void;
  unregisterAgent: (id: string) => void;
  setDiscoveryStatus: (isDiscovering: boolean, lastTime?: number) => void;

  addRun: (agentId: string, run: Run) => void;
  updateRun: (agentId: string, runId: string, updates: Partial<Run>) => void;
  removeRun: (agentId: string, runId: string) => void;
  removeAllRuns: (agentId: string) => void;

  setAgentFilter: (filter: Partial<AgentFilter>) => void;
  setAgentSort: (sort: AgentSortOption) => void;
  setRunFilter: (filter: Partial<RunFilter>) => void;
  setRunSort: (sort: RunSortOption) => void;

  // Getters
  getSelectedAgent: () => Agent | null;
  getFilteredAgents: () => Agent[];
  getSortedAgents: () => Agent[];
  getAgentRuns: (agentId: string) => Run[];
  getFilteredRuns: (agentId: string) => Run[];
  getSortedRuns: (agentId: string) => Run[];
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      // Initial state
      agents: [],
      selectedAgentId: null,
      expandedAgentIds: new Set(),
      discoveredAgents: [],
      registeredAgents: [],
      lastDiscoveryTime: null,
      isDiscovering: false,
      agentFilter: {
        searchQuery: '',
      },
      agentSort: 'recent',
      runFilter: {
        searchQuery: '',
      },
      runSort: 'recent',

      // Actions
      setAgents: (agents) =>
        set({
          agents,
        }),

      addAgent: (agent) =>
        set((state) => {
          // Check if agent already exists
          const existingIndex = state.agents.findIndex((a) => a.id === agent.id);
          if (existingIndex >= 0) {
            // Merge with existing agent, preserving runs
            const existing = state.agents[existingIndex];
            const merged = {
              ...existing,
              ...agent,
              // Keep existing runs if the new agent doesn't have any
              runs: agent.runs.length > 0 ? agent.runs : existing.runs,
              runCount: agent.runs.length > 0 ? agent.runCount : existing.runCount,
              lastRunAt: agent.lastRunAt ?? existing.lastRunAt,
            };
            const newAgents = [
              ...state.agents,
            ];
            newAgents[existingIndex] = merged;
            return {
              agents: newAgents,
            };
          }
          // Add new agent
          return {
            agents: [
              ...state.agents,
              agent,
            ],
          };
        }),

      updateAgent: (id, updates) =>
        set((state) => ({
          agents: state.agents.map((agent) =>
            agent.id === id
              ? {
                  ...agent,
                  ...updates,
                }
              : agent,
          ),
        })),

      removeAgent: (id) =>
        set((state) => ({
          agents: state.agents.filter((agent) => agent.id !== id),
          selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
          expandedAgentIds: new Set(
            [
              ...state.expandedAgentIds,
            ].filter((aid) => aid !== id),
          ),
        })),

      selectAgent: (id) =>
        set({
          selectedAgentId: id,
        }),

      toggleAgentExpanded: (id) =>
        set((state) => {
          const expanded = new Set(state.expandedAgentIds);
          if (expanded.has(id)) {
            expanded.delete(id);
          } else {
            expanded.add(id);
          }
          return {
            expandedAgentIds: expanded,
          };
        }),

      expandAgent: (id) =>
        set((state) => ({
          expandedAgentIds: new Set([
            ...state.expandedAgentIds,
            id,
          ]),
        })),

      collapseAgent: (id) =>
        set((state) => {
          const expanded = new Set(state.expandedAgentIds);
          expanded.delete(id);
          return {
            expandedAgentIds: expanded,
          };
        }),

      expandAll: () =>
        set((state) => ({
          expandedAgentIds: new Set(state.agents.map((a) => a.id)),
        })),

      collapseAll: () =>
        set({
          expandedAgentIds: new Set(),
        }),

      setDiscoveredAgents: (agents) =>
        set({
          discoveredAgents: agents,
          lastDiscoveryTime: Date.now(),
        }),

      addDiscoveredAgent: (agent) =>
        set((state) => ({
          discoveredAgents: [
            ...state.discoveredAgents,
            agent,
          ],
        })),

      registerAgent: (agent) =>
        set((state) => ({
          registeredAgents: [
            ...state.registeredAgents,
            agent,
          ],
        })),

      unregisterAgent: (id) =>
        set((state) => ({
          registeredAgents: state.registeredAgents.filter((a) => a.id !== id),
        })),

      setDiscoveryStatus: (isDiscovering, lastTime) =>
        set((state) => ({
          isDiscovering,
          lastDiscoveryTime: lastTime ?? state.lastDiscoveryTime,
        })),

      addRun: (agentId, run) =>
        set((state) => ({
          agents: state.agents.map((agent) => {
            if (agent.id !== agentId) {
              return agent;
            }
            const runs = [
              run,
              ...agent.runs,
            ];
            return {
              ...agent,
              runs,
              runCount: runs.length,
              lastRunAt: run.startTime,
            };
          }),
        })),

      updateRun: (agentId, runId, updates) =>
        set((state) => ({
          agents: state.agents.map((agent) => {
            if (agent.id !== agentId) {
              return agent;
            }
            return {
              ...agent,
              runs: agent.runs.map((run) =>
                run.id === runId
                  ? {
                      ...run,
                      ...updates,
                    }
                  : run,
              ),
            };
          }),
        })),

      removeRun: (agentId, runId) =>
        set((state) => ({
          agents: state.agents.map((agent) => {
            if (agent.id !== agentId) {
              return agent;
            }
            const runs = agent.runs.filter((r) => r.id !== runId);
            return {
              ...agent,
              runs,
              runCount: runs.length,
              lastRunAt: runs[0]?.startTime ?? null,
            };
          }),
        })),

      removeAllRuns: (agentId) =>
        set((state) => ({
          agents: state.agents.map((agent) => {
            if (agent.id !== agentId) {
              return agent;
            }
            return {
              ...agent,
              runs: [],
              runCount: 0,
              lastRunAt: null,
            };
          }),
        })),

      setAgentFilter: (filter) =>
        set((state) => ({
          agentFilter: {
            ...state.agentFilter,
            ...filter,
          },
        })),

      setAgentSort: (sort) =>
        set({
          agentSort: sort,
        }),

      setRunFilter: (filter) =>
        set((state) => ({
          runFilter: {
            ...state.runFilter,
            ...filter,
          },
        })),

      setRunSort: (sort) =>
        set({
          runSort: sort,
        }),

      // Getters
      getSelectedAgent: () => {
        const { agents, selectedAgentId } = get();
        return agents.find((a) => a.id === selectedAgentId) ?? null;
      },

      getFilteredAgents: () => {
        const { agents, agentFilter } = get();
        let filtered = agents;

        if (agentFilter.searchQuery) {
          const query = agentFilter.searchQuery.toLowerCase();
          filtered = filtered.filter(
            (agent) =>
              agent.name.toLowerCase().includes(query) ||
              agent.filePath.toLowerCase().includes(query) ||
              agent.description?.toLowerCase().includes(query),
          );
        }

        if (agentFilter.hasRuns) {
          filtered = filtered.filter((agent) => agent.runCount > 0);
        }

        return filtered;
      },

      getSortedAgents: () => {
        const { getFilteredAgents, agentSort } = get();
        const filtered = getFilteredAgents();

        return [
          ...filtered,
        ].sort((a, b) => {
          switch (agentSort) {
            case 'recent':
              return (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0);
            case 'oldest':
              return (
                (a.lastRunAt ?? Number.POSITIVE_INFINITY) -
                (b.lastRunAt ?? Number.POSITIVE_INFINITY)
              );
            case 'name':
              return a.name.localeCompare(b.name);
            case 'runs':
              return b.runCount - a.runCount;
            default:
              return 0;
          }
        });
      },

      getAgentRuns: (agentId) => {
        const agent = get().agents.find((a) => a.id === agentId);
        return agent?.runs ?? [];
      },

      getFilteredRuns: (agentId) => {
        const runs = get().getAgentRuns(agentId);
        const { runFilter } = get();

        let filtered = runs;

        if (runFilter.searchQuery) {
          const query = runFilter.searchQuery.toLowerCase();
          filtered = filtered.filter(
            (run) =>
              run.inputPreview.toLowerCase().includes(query) ||
              run.id.toLowerCase().includes(query),
          );
        }

        if (runFilter.statuses && runFilter.statuses.length > 0) {
          filtered = filtered.filter((run) => runFilter.statuses?.includes(run.status));
        }

        if (runFilter.dateRange) {
          filtered = filtered.filter(
            (run) =>
              run.startTime >= runFilter.dateRange!.start &&
              run.startTime <= runFilter.dateRange!.end,
          );
        }

        return filtered;
      },

      getSortedRuns: (agentId) => {
        const { getFilteredRuns, runSort } = get();
        const filtered = getFilteredRuns(agentId);

        return [
          ...filtered,
        ].sort((a, b) => {
          switch (runSort) {
            case 'recent':
              return b.startTime - a.startTime;
            case 'oldest':
              return a.startTime - b.startTime;
            case 'duration':
              return (b.durationMs ?? 0) - (a.durationMs ?? 0);
            case 'cost':
              return b.totalCost - a.totalCost;
            case 'memory':
              return b.memoryBytes - a.memoryBytes;
            default:
              return 0;
          }
        });
      },
    }),
    {
      name: 'noetic-ui-agents',
      partialize: (state) => ({
        agents: state.agents.map((agent) => ({
          ...agent,
          runs: agent.runs.slice(0, 50), // Persist only last 50 runs per agent
        })),
        registeredAgents: state.registeredAgents,
        agentSort: state.agentSort,
        runSort: state.runSort,
      }),
    },
  ),
);
