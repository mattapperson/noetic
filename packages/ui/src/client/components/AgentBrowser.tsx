/**
 * Agent browser component (left sidebar)
 * Main entry point for agent discovery and browsing
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { discoverAgents } from '../lib/discovery';
import { deserialize } from '../lib/serialization';
import { useAgentStore } from '../stores/agent';
import { useStorageStore } from '../stores/storage';
import type { Agent } from '../types/agent';
import AgentList from './AgentList';
import GettingStartedGuide from './GettingStartedGuide';
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
  const [_isLoading, _setIsLoading] = useState(true);

  // Use ref to track fetch state - survives React StrictMode and prevents tight loops
  const hasFetchedRef = useRef(false);
  const isFetchingRef = useRef(false);

  useEffect(() => {
    // Prevent any fetch if already done or in progress
    if (hasFetchedRef.current || isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;

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
                    addRun(id, deserialize(run));
                  }
                  console.log(`[AgentBrowser] Loaded ${runsData.data.length} runs for agent:`, id);
                }
              }
            } catch (runsError) {
              console.error(`[AgentBrowser] Failed to fetch runs for agent ${id}:`, runsError);
            }
          }
        }
      } catch (error) {
        console.error('[AgentBrowser] Failed to fetch agents:', error);
      } finally {
        hasFetchedRef.current = true;
        isFetchingRef.current = false;
        _setIsLoading(false);
      }
    };

    fetchAgentsAndRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - only run once on mount

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

  const handleAgentSortChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const v = e.target.value;
      if (v === 'recent' || v === 'oldest' || v === 'name' || v === 'runs') {
        setAgentSort(v);
      }
    },
    [
      setAgentSort,
    ],
  );

  const handleRunSortChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const v = e.target.value;
      if (v === 'recent' || v === 'oldest' || v === 'duration' || v === 'cost' || v === 'memory') {
        setRunSort(v);
      }
    },
    [
      setRunSort,
    ],
  );

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
                      // Deserialize to convert any serialized Maps back to Map instances
                      addRun(id, deserialize(run));
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
    // Use ISO date format to avoid hydration mismatches with locale-dependent toLocaleDateString
    const date = new Date(lastDiscoveryTime);
    return date.toISOString().split('T')[0];
  };

  const sortedAgents = getSortedAgents();
  const hasAgents = agents.length > 0;

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

      {/* Filter, Sort, Refresh, and Status — hidden when no agents */}
      {hasAgents && (
        <>
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

            {/* Agent Sort */}
            <select
              value={agentSort}
              onChange={handleAgentSortChange}
              title="Sort agents"
              style={{
                fontSize: '11px',
                padding: '6px 4px',
                borderRadius: '4px',
                border: '1px solid var(--noetic-border)',
                backgroundColor: 'var(--noetic-input-bg)',
                color: 'var(--noetic-text)',
                cursor: 'pointer',
              }}
            >
              <option value="recent">Agents: Recent</option>
              <option value="oldest">Agents: Oldest</option>
              <option value="name">Agents: Name</option>
              <option value="runs">Agents: Runs</option>
            </select>

            {/* Run Sort */}
            <select
              value={runSort}
              onChange={handleRunSortChange}
              title="Sort runs"
              style={{
                fontSize: '11px',
                padding: '6px 4px',
                borderRadius: '4px',
                border: '1px solid var(--noetic-border)',
                backgroundColor: 'var(--noetic-input-bg)',
                color: 'var(--noetic-text)',
                cursor: 'pointer',
              }}
            >
              <option value="recent">Runs: Recent</option>
              <option value="oldest">Runs: Oldest</option>
              <option value="duration">Runs: Duration</option>
              <option value="cost">Runs: Cost</option>
              <option value="memory">Runs: Memory</option>
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
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label="Refresh"
                style={{
                  animation: isDiscovering ? 'spin 1s linear infinite' : undefined,
                }}
              >
                <path d="M13 8a5 5 0 1 1-1.2-3.25" />
                <polyline points="13 3 13 6 10 6" />
              </svg>
              <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
            </button>
          </div>

          {/* Discovery status */}
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
              {agents.length} agent{agents.length !== 1 ? 's' : ''} • Last scan:{' '}
              {formatDiscoveryTime()}
            </span>
          </div>
        </>
      )}

      {/* Agent list */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '8px',
        }}
      >
        {_isLoading && agents.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--noetic-text-muted)',
              fontSize: '12px',
            }}
          >
            <span
              style={{
                marginRight: '8px',
              }}
            >
              ⏳
            </span>
            Loading agents...
          </div>
        ) : sortedAgents.length === 0 ? (
          <GettingStartedGuide />
        ) : (
          <AgentList agents={sortedAgents} />
        )}
      </div>

      {/* Storage bar */}
      <StorageBar onClearAll={handleClearAllStorage} />
    </div>
  );
};

export default AgentBrowser;
