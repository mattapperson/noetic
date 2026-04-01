'use client';

/**
 * Hook to process WebSocket execution messages and update stores
 */

import { useEffect } from 'react';
import type { ExecutionNode, ExecutionTrace, ServerMessage } from '../../shared/protocol';
import { useAgentStore } from '../stores/agent';
import { useExecutionStore } from '../stores/execution';
import { registerMessageHandler } from '../stores/websocket';
import type { Run } from '../types/agent';

export function useExecutionMessages(): void {
  const addRun = useAgentStore((state) => state.addRun);
  const updateRun = useAgentStore((state) => state.updateRun);
  const addAgent = useAgentStore((state) => state.addAgent);
  const agents = useAgentStore((state) => state.agents);
  const addTrace = useExecutionStore((state) => state.addTrace);
  const addNode = useExecutionStore((state) => state.addNode);
  const updateNode = useExecutionStore((state) => state.updateNode);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    console.log('[useExecutionMessages] Registering handler');

    const handler = (message: ServerMessage) => {
      console.log('[useExecutionMessages] Processing message:', message.type);

      // Type narrowing using discriminated union based on message.type
      switch (message.type) {
        case 'execution.start': {
          const trace: ExecutionTrace = message.trace;
          const agentId: string = message.agentId;

          // Ensure agent exists before adding run
          const agentExists = agents.some((a) => a.id === agentId);
          if (!agentExists) {
            console.log('[useExecutionMessages] Creating agent for run:', agentId);
            addAgent({
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
              description: 'Agent auto-discovered via WebSocket',
              tags: [],
            });
          }

          // Create a run from the trace
          const run: Run = {
            id: trace.traceId,
            agentId,
            startTime: trace.startTime,
            endTime: null,
            durationMs: null,
            status: 'running',
            input: {},
            inputPreview: 'Execution started',
            trace,
            rootNodeId: trace.rootNodeId,
            timelineEvents: [],
            currentTimelinePosition: 0,
            totalSteps: 0,
            totalTokens: {
              input: 0,
              output: 0,
              total: 0,
            },
            totalCost: 0,
            maxDepth: 0,
            memoryBytes: 0,
            maxMemoryBytes: 0,
            recordingVersion: '1.0',
            isLive: true,
            breakpointsHit: [],
            pauseHistory: [],
          };

          console.log('[useExecutionMessages] Adding run:', run.id, 'for agent:', agentId);
          addRun(agentId, run);
          addTrace(trace);
          break;
        }

        case 'execution.complete': {
          const agentId: string = message.agentId;
          const traceId: string = message.traceId;
          const summary = message.summary;

          console.log('[useExecutionMessages] Completing run:', traceId);
          updateRun(agentId, traceId, {
            status: 'completed',
            endTime: Date.now(),
            durationMs: summary.durationMs,
            totalSteps: summary.totalNodes,
            totalTokens: summary.totalTokens,
            totalCost: summary.totalCost,
            isLive: false,
          });
          break;
        }

        case 'execution.error': {
          const agentId: string = message.agentId;
          const traceId: string = message.traceId;

          console.log('[useExecutionMessages] Error in run:', traceId);
          updateRun(agentId, traceId, {
            status: 'error',
            endTime: Date.now(),
            isLive: false,
          });
          break;
        }

        case 'node.start': {
          const node: ExecutionNode = message.node;
          addNode(node);
          break;
        }

        case 'node.complete': {
          const nodeId: string = message.nodeId;
          const output: unknown = message.output;
          const durationMs: number = message.durationMs;

          updateNode(nodeId, {
            output,
            durationMs,
            status: 'completed',
            endTime: Date.now(),
          });
          break;
        }

        case 'node.error': {
          const nodeId: string = message.nodeId;
          const error = message.error;

          updateNode(nodeId, {
            error,
            status: 'error',
            endTime: Date.now(),
          });
          break;
        }

        default:
          // Ignore other message types (pong, node.pause, node.data, etc.)
          break;
      }
    };

    return registerMessageHandler(handler);
  }, [
    addRun,
    updateRun,
    addAgent,
    agents,
    addTrace,
    addNode,
    updateNode,
  ]);
}
