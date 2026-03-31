/**
 * Agent browser component (left sidebar)
 * Main entry point for agent discovery and browsing
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { discoverAgents } from '../lib/discovery';
import { useAgentStore } from '../stores/agent';
import { useStorageStore } from '../stores/storage';
import AgentList from './AgentList';
import StorageBar from './StorageBar';

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
    getSortedAgents,
  } = useAgentStore();

  const { clearAllStorage } = useStorageStore();
  const [searchQuery, setSearchQuery] = useState(agentFilter.searchQuery);

  // Fetch agents from server on mount
  const [serverAgentsLoaded, setServerAgentsLoaded] = useState(false);
  const { addAgent } = useAgentStore();

  useEffect(() => {
    if (serverAgentsLoaded) return;

    const fetchAgents = async () => {
      try {
        console.log('[AgentBrowser] Fetching agents from server...');
        const response = await fetch('/api/agents');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('[AgentBrowser] Server response:', data);

        if (data.success && Array.isArray(data.data) && data.data.length > 0) {
          // Add each agent from server if not already present
          const currentIds = new Set(agents.map((a) => a.id));

          data.data.forEach((id: string) => {
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
          });

          setServerAgentsLoaded(true);
        }
      } catch (error) {
        console.error('[AgentBrowser] Failed to fetch agents:', error);
      }
    };

    fetchAgents();
  }, [
    serverAgentsLoaded,
    agents,
    addAgent,
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

  const handleRefreshDiscovery = useCallback(async () => {
    setDiscoveryStatus(true);

    try {
      // Discover agents from file system
      const discovered = await discoverAgents('/');
      setDiscoveredAgents(discovered);

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
      const mergedAgents = newAgents.map((newAgent) => {
        const existing = agents.find((a) => a.id === newAgent.id);
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

      setAgents(mergedAgents);
    } catch (error) {
      console.error('Discovery failed:', error);
    } finally {
      setDiscoveryStatus(false, Date.now());
    }
  }, [
    agents,
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
        width: '280px',
        backgroundColor: 'var(--noetic-sidebar-bg)',
        borderRight: '1px solid var(--noetic-border)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px',
          borderBottom: '1px solid var(--noetic-border)',
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

      {/* Search */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--noetic-border)',
        }}
      >
        <div
          style={{
            position: 'relative',
          }}
        >
          <span
            style={{
              position: 'absolute',
              left: '10px',
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
            placeholder="Search agents..."
            value={searchQuery}
            onChange={handleSearch}
            style={{
              width: '100%',
              padding: '8px 8px 8px 32px',
              fontSize: '12px',
              borderRadius: '4px',
              border: '1px solid var(--noetic-border)',
              backgroundColor: 'var(--noetic-input-bg)',
              color: 'var(--noetic-text)',
              outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Discovery status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          borderBottom: '1px solid var(--noetic-border)',
          fontSize: '11px',
          color: 'var(--noetic-text-muted)',
        }}
      >
        <span>Last scan: {formatDiscoveryTime()}</span>
        <button
          type="button"
          onClick={handleRefreshDiscovery}
          disabled={isDiscovering}
          style={{
            padding: '4px 8px',
            fontSize: '10px',
            borderRadius: '4px',
            border: '1px solid var(--noetic-border)',
            backgroundColor: 'var(--noetic-button-bg)',
            color: 'var(--noetic-text)',
            cursor: isDiscovering ? 'not-allowed' : 'pointer',
            opacity: isDiscovering ? 0.6 : 1,
          }}
        >
          {isDiscovering ? 'Scanning...' : '🔄 Refresh'}
        </button>
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
