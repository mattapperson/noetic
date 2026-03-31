import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  ContextSnapshot,
  ExecutionNode,
  ExecutionTrace,
  NodeStatus,
  NoeticError,
  RunStatus,
  StepData,
  StepKind,
  TokenUsage,
} from '../../shared/protocol';

export type { ContextSnapshot, ExecutionNode, ExecutionTrace, StepData, TokenUsage };

export interface ExecutionNodeError {
  message: string;
  code?: string;
  stack?: string;
}

export interface Run {
  id: string;
  agentId: string;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  status: RunStatus;
  input: unknown;
  inputPreview: string;
  totalSteps: number;
  totalTokens: TokenUsage;
  totalCost: number;
  maxDepth: number;
  memoryBytes: number;
  isLive: boolean;
  rootNodeId: string;
  trace?: ExecutionTrace;
}

export interface Agent {
  id: string;
  name: string;
  filePath: string;
  exportName: string;
  discoveredAt: number;
  lastModified: number;
  runCount: number;
  lastRunAt: number | null;
  description?: string;
  tags?: string[];
  runs: Run[];
}

// Store state
interface ExecutionState {
  // Agents
  agents: Map<string, Agent>;
  selectedAgentId: string | null;

  // Runs
  runs: Map<string, Run>;
  currentRun: Run | null;

  // Trace data
  traces: Map<string, ExecutionTrace>;
  nodes: Map<string, ExecutionNode>;
  selectedNode: ExecutionNode | null;

  // Timeline
  currentTimelinePosition: number;
  isPlaying: boolean;
  playbackSpeed: number;

  // Actions
  setAgents: (agents: Agent[]) => void;
  selectAgent: (agentId: string | null) => void;
  addRun: (run: Run) => void;
  selectRun: (runId: string | null) => void;
  updateRun: (runId: string, updates: Partial<Run>) => void;
  addTrace: (trace: ExecutionTrace) => void;
  addNode: (node: ExecutionNode) => void;
  updateNode: (nodeId: string, updates: Partial<ExecutionNode>) => void;
  selectNode: (nodeId: string | null) => void;
  setTimelinePosition: (position: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setPlaybackSpeed: (speed: number) => void;
}

export const useExecutionStore = create<ExecutionState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    agents: new Map(),
    selectedAgentId: null,
    runs: new Map(),
    currentRun: null,
    traces: new Map(),
    nodes: new Map(),
    selectedNode: null,
    currentTimelinePosition: 0,
    isPlaying: false,
    playbackSpeed: 1,

    // Actions
    setAgents: (agents) => {
      const agentsMap = new Map(
        agents.map((a) => [
          a.id,
          a,
        ]),
      );
      set({
        agents: agentsMap,
      });
    },

    selectAgent: (agentId) => {
      set({
        selectedAgentId: agentId,
      });

      // If agent selected, set the most recent run as current
      if (agentId) {
        const agent = get().agents.get(agentId);
        if (agent && agent.runs.length > 0) {
          const mostRecentRun = agent.runs[0];
          get().selectRun(mostRecentRun.id);
        }
      }
    },

    addRun: (run) => {
      set((state) => {
        const newRuns = new Map(state.runs);
        newRuns.set(run.id, run);

        // Update agent's run list
        const newAgents = new Map(state.agents);
        const agent = newAgents.get(run.agentId);
        if (agent) {
          agent.runs = [
            run,
            ...agent.runs,
          ];
          agent.runCount = agent.runs.length;
          agent.lastRunAt = run.startTime;
          newAgents.set(run.agentId, agent);
        }

        return {
          runs: newRuns,
          agents: newAgents,
        };
      });
    },

    selectRun: (runId) => {
      const run = runId ? get().runs.get(runId) || null : null;
      set({
        currentRun: run,
        selectedNode: null,
        currentTimelinePosition: 0,
      });
    },

    updateRun: (runId, updates) => {
      set((state) => {
        const run = state.runs.get(runId);
        if (!run) {
          return state;
        }

        const newRuns = new Map(state.runs);
        newRuns.set(runId, {
          ...run,
          ...updates,
        });

        // Update currentRun if it's the one being updated
        const newCurrentRun =
          state.currentRun?.id === runId
            ? {
                ...state.currentRun,
                ...updates,
              }
            : state.currentRun;

        return {
          runs: newRuns,
          currentRun: newCurrentRun,
        };
      });
    },

    addTrace: (trace) => {
      set((state) => {
        const newTraces = new Map(state.traces);
        newTraces.set(trace.traceId, trace);
        return {
          traces: newTraces,
        };
      });
    },

    addNode: (node) => {
      set((state) => {
        const newNodes = new Map(state.nodes);
        newNodes.set(node.id, node);
        return {
          nodes: newNodes,
        };
      });
    },

    updateNode: (nodeId, updates) => {
      set((state) => {
        const node = state.nodes.get(nodeId);
        if (!node) {
          return state;
        }

        const newNodes = new Map(state.nodes);
        const updatedNode = {
          ...node,
          ...updates,
        };
        newNodes.set(nodeId, updatedNode);

        // Update selectedNode if it's the one being updated
        const newSelectedNode =
          state.selectedNode?.id === nodeId ? updatedNode : state.selectedNode;

        return {
          nodes: newNodes,
          selectedNode: newSelectedNode,
        };
      });
    },

    selectNode: (nodeId) => {
      const node = nodeId ? get().nodes.get(nodeId) || null : null;
      set({
        selectedNode: node,
      });
    },

    setTimelinePosition: (position) => {
      set({
        currentTimelinePosition: Math.max(0, Math.min(1, position)),
      });
    },

    setIsPlaying: (playing) => {
      set({
        isPlaying: playing,
      });
    },

    setPlaybackSpeed: (speed) => {
      set({
        playbackSpeed: Math.max(0.5, Math.min(10, speed)),
      });
    },
  })),
);
