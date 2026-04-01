/**
 * Agent browser component (left sidebar)
 * Main entry point for agent discovery and browsing
 */

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { discoverAgents } from '../lib/discovery';
import { deserialize } from '../lib/serialization';
import { useAgentStore } from '../stores/agent';
import { useStorageStore } from '../stores/storage';
import type { Agent } from '../types/agent';
import AgentList from './AgentList';
import StorageBar from './StorageBar';
import ThemeToggle from './ThemeToggle';

export const AgentBrowser: React.FC = () => {
  const {
    agents,
    setAgents,
    setDiscoveredAgents,
    setDiscoveryStatus,
    isDiscovering,
    lastDiscoveryTime,
    agentFilter,
    setAgentFilter,
    agentSort,
    runSort,
    setAgentSort,
    setRunSort,
    getSortedAgents,
  } = useAgentStore();

  const { clearAllStorage } = useStorageStore();
  const [searchQuery, setSearchQuery] = useState(agentFilter.searchQuery);

  // Fetch agents and their runs from server on mount
  const [serverAgentsLoaded, setServerAgentsLoaded] = useState(false);

  useEffect(() => {
    if (serverAgentsLoaded) {
      return;
    }

    const fetchAgentsAndRuns = async () => {
      try {
        console.log('[AgentBrowser] Fetching agents from server...');
        const response = await fetch('/api/agents');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('[AgentBrowser] Server response:', data);

        if (data.success && Array.isArray(data.data)) {
          // Add each agent from server if not already present
          // Use getState() to avoid stale closure issues
          const { agents, addAgent } = useAgentStore.getState();
          const currentIds = new Set(agents.map((a) => a.id));

          for (const id of data.data) {
            if (!currentIds.has(id)) {
              addAgent({
                id,
                name: id,
                filePath: '',
                exportName: '',
                discoveredAt: Date.now(),
                lastModified: Date.now(),
                discoveryMethod: 'runtime',
                runs: [],
                runCount: 0,
                lastRunAt: null,
                description: 'Agent auto-discovered via WebSocket',
                tags: [],
              });
              console.log('[AgentBrowser] Added agent:', id);
            }

            // Fetch runs for this agent
            try {
              const runsResponse = await fetch(`/api/agents/${id}/runs`);
              if (runsResponse.ok) {
                const runsData = await runsResponse.json();
                if (runsData.success && Array.isArray(runsData.data) && runsData.data.length > 0) {
                  const { addRun } = useAgentStore.getState();
                  for (const run of runsData.data) {
                    addRun(id, run);
                  }
                  console.log(`[AgentBrowser] Loaded ${runsData.data.length} runs for agent:`, id);
                }
              }
            } catch (runsError) {
              console.error(`[AgentBrowser] Failed to fetch runs for agent ${id}:`, runsError);
            }
          }

          setServerAgentsLoaded(true);
        }
      } catch (error) {
        console.error('[AgentBrowser] Failed to fetch agents:', error);
      }
    };

    fetchAgentsAndRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    serverAgentsLoaded,
  ]);

  const handleSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearchQuery(value);
      setAgentFilter({
        searchQuery: value,
      });
    },
    [
      setAgentFilter,
    ],
  );

  // Combined sort options with optgroups
  const combinedSortOptions = [
    {
      type: 'optgroup',
      label: 'Agents',
    },
    {
      value: 'agent-recent',
      label: 'Recent first',
    },
    {
      value: 'agent-oldest',
      label: 'Oldest first',
    },
    {
      value: 'agent-name',
      label: 'Name',
    },
    {
      value: 'agent-runs',
      label: 'Run count',
    },
    {
      type: 'optgroup',
      label: 'Runs',
    },
    {
      value: 'run-recent',
      label: 'Recent first',
    },
    {
      value: 'run-oldest',
      label: 'Oldest first',
    },
    {
      value: 'run-duration',
      label: 'Duration',
    },
    {
      value: 'run-cost',
      label: 'Cost',
    },
    {
      value: 'run-memory',
      label: 'Memory',
    },
  ];

  const handleSortChange = useCallback(
    (value: string) => {
      if (value.startsWith('agent-')) {
        const sortValue = value.replace('agent-', '');
        if (
          sortValue === 'recent' ||
          sortValue === 'oldest' ||
          sortValue === 'name' ||
          sortValue === 'runs'
        ) {
          setAgentSort(sortValue);
        }
      } else if (value.startsWith('run-')) {
        const sortValue = value.replace('run-', '');
        if (
          sortValue === 'recent' ||
          sortValue === 'oldest' ||
          sortValue === 'duration' ||
          sortValue === 'cost' ||
          sortValue === 'memory'
        ) {
          setRunSort(sortValue);
        }
      }
    },
    [
      setAgentSort,
      setRunSort,
    ],
  );

  // Get current sort value for the dropdown
  // If runSort is not the default, a run sort option is active
  const currentSortValue =
    agentSort === 'recent' && runSort !== 'recent' ? `run-${runSort}` : `agent-${agentSort}`;

  const handleRefreshDiscovery = useCallback(async () => {
    setDiscoveryStatus(true);

    try {
      // Get current state from store to avoid stale closures
      const { agents: currentAgents, addAgent: addAgentToStore } = useAgentStore.getState();

      // First, refresh agents from server API (includes runtime-registered agents)
      const response = await fetch('/api/agents');
      if (response.ok) {
        const data = await response.json();
        if (data.success && Array.isArray(data.data)) {
          const currentIds = new Set(currentAgents.map((a) => a.id));

          // Add any new server agents and fetch their runs
          for (const id of data.data) {
            if (!currentIds.has(id)) {
              addAgentToStore({
                id,
                name: id,
                filePath: '',
                exportName: '',
                discoveredAt: Date.now(),
                lastModified: Date.now(),
                discoveryMethod: 'runtime',
                runs: [],
                runCount: 0,
                lastRunAt: null,
                description: 'Agent auto-discovered via WebSocket',
                tags: [],
              });

              // Fetch runs for this agent
              try {
                const runsResponse = await fetch(`/api/agents/${id}/runs`);
                if (runsResponse.ok) {
                  const runsData = await runsResponse.json();
                  if (
                    runsData.success &&
                    Array.isArray(runsData.data) &&
                    runsData.data.length > 0
                  ) {
                    const { addRun } = useAgentStore.getState();
                    for (const run of runsData.data) {
                      addRun(id, run);
                    }
                    console.log(
                      `[AgentBrowser] Loaded ${runsData.data.length} runs for agent:`,
                      id,
                    );
                  }
                }
              } catch (runsError) {
                console.error(`[AgentBrowser] Failed to fetch runs for agent ${id}:`, runsError);
              }
            }
          }
        }
      }

      // Then discover agents from file system
      const discovered = await discoverAgents('/');
      setDiscoveredAgents(discovered);

      // Get fresh state after adding server agents
      const { agents: freshAgents } = useAgentStore.getState();

      // Convert discovered agents to full agents
      const newAgents = discovered.map((d) => ({
        id: d.id,
        name: d.name,
        filePath: d.filePath,
        exportName: d.exportName,
        discoveredAt: d.discoveredAt,
        lastModified: Date.now(),
        discoveryMethod: 'static' as const,
        runs: [],
        runCount: 0,
        lastRunAt: null,
        description: d.description,
        tags: [],
      }));

      // Merge with existing agents, preserving runs
      const mergedAgents: Agent[] = newAgents.map((newAgent) => {
        const existing = freshAgents.find((a) => a.id === newAgent.id);
        if (existing) {
          return {
            ...newAgent,
            runs: existing.runs,
            runCount: existing.runCount,
            lastRunAt: existing.lastRunAt,
          };
        }
        return newAgent;
      });

      // Add any existing agents that weren't in the file system discovery
      // (preserves runtime-registered agents and agents with runs)
      freshAgents.forEach((existingAgent) => {
        const foundInNew = mergedAgents.find((a) => a.id === existingAgent.id);
        if (!foundInNew) {
          mergedAgents.push(existingAgent);
        }
      });

      setAgents(mergedAgents);
    } catch (error) {
      console.error('Discovery failed:', error);
    } finally {
      setDiscoveryStatus(false, Date.now());
    }
  }, [
    setAgents,
    setDiscoveredAgents,
    setDiscoveryStatus,
  ]);

  const handleClearAllStorage = useCallback(() => {
    clearAllStorage();
  }, [
    clearAllStorage,
  ]);

  const sortedAgents = getSortedAgents();

  // Format last discovery time
  const formatDiscoveryTime = () => {
    if (!lastDiscoveryTime) {
      return 'Never';
    }
    const diff = Date.now() - lastDiscoveryTime;
    if (diff < 60000) {
      return 'Just now';
    }
    if (diff < 3600000) {
      return `${Math.floor(diff / 60000)}m ago`;
    }
    if (diff < 86400000) {
      return `${Math.floor(diff / 3600000)}h ago`;
    }
    return new Date(lastDiscoveryTime).toLocaleDateString();
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        backgroundColor: 'var(--noetic-sidebar-bg)',
        borderRight: '1px solid var(--noetic-border)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px',
          borderBottom: '1px solid var(--noetic-border)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '12px',
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: '16px',
              fontWeight: 600,
              color: 'var(--noetic-text)',
            }}
          >
            Noetic UI
          </h1>
          <p
            style={{
              margin: '4px 0 0 0',
              fontSize: '12px',
              color: 'var(--noetic-text-muted)',
            }}
          >
            Agent Debugger
          </p>
        </div>
        <ThemeToggle />
      </div>

      {/* Combined Filter, Sort, and Refresh Row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 16px',
          borderBottom: '1px solid var(--noetic-border)',
        }}
      >
        {/* Filter Input */}
        <div
          style={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
          }}
        >
          <span
            style={{
              position: 'absolute',
              left: '8px',
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: '12px',
              color: 'var(--noetic-text-muted)',
            }}
          >
            🔍
          </span>
          <input
            type="text"
            placeholder="Filter agents"
            value={searchQuery}
            onChange={handleSearch}
            style={{
              width: '100%',
              padding: '6px 8px 6px 28px',
              fontSize: '12px',
              borderRadius: '4px',
              border: '1px solid var(--noetic-border)',
              backgroundColor: 'var(--noetic-input-bg)',
              color: 'var(--noetic-text)',
              outline: 'none',
            }}
          />
        </div>

        {/* Sort Select */}
        <select
          value={currentSortValue}
          onChange={(e) => handleSortChange(e.target.value)}
          style={{
            fontSize: '11px',
            padding: '6px 8px',
            borderRadius: '4px',
            border: '1px solid var(--noetic-border)',
            backgroundColor: 'var(--noetic-input-bg)',
            color: 'var(--noetic-text)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {combinedSortOptions.map((opt, index) =>
            opt.type === 'optgroup' ? (
              <optgroup key={`group-${index}`} label={opt.label} />
            ) : (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ),
          )}
        </select>

        {/* Refresh Button */}
        <button
          type="button"
          onClick={handleRefreshDiscovery}
          disabled={isDiscovering}
          title="Refresh agents"
          style={{
            width: '28px',
            height: '28px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
            border: '1px solid var(--noetic-border)',
            backgroundColor: 'var(--noetic-button-bg)',
            color: 'var(--noetic-text)',
            cursor: isDiscovering ? 'not-allowed' : 'pointer',
            opacity: isDiscovering ? 0.6 : 1,
            fontSize: '14px',
            padding: 0,
          }}
          onMouseEnter={(e) => {
            if (!isDiscovering) {
              e.currentTarget.style.backgroundColor = 'var(--noetic-button-hover)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--noetic-button-bg)';
          }}
        >
          {isDiscovering ? '⏳' : '🔄'}
        </button>
      </div>

      {/* Discovery status - simplified */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 16px',
          fontSize: '10px',
          color: 'var(--noetic-text-muted)',
        }}
      >
        <span>
          {agents.length} agent{agents.length !== 1 ? 's' : ''} • Last scan: {formatDiscoveryTime()}
        </span>
      </div>

      {/* Agent list */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '8px',
        }}
      >
        <AgentList agents={sortedAgents} />
      </div>

      {/* Storage bar */}
      <StorageBar onClearAll={handleClearAllStorage} />
    </div>
  );
};

export default AgentBrowser;
