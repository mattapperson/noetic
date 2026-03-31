/**
 * Hook to process WebSocket execution messages and update stores
 */

import { useEffect } from 'react';
import type { ExecutionNode, ExecutionTrace, ServerMessage } from '../../shared/protocol';
import { useAgentStore } from '../stores/agent';
import { useExecutionStore } from '../stores/execution';
import type { Run } from '../types/agent';
import { useConnection } from './useConnection';

export function useExecutionMessages(): void {
  const { lastServerMessage } = useConnection();
  const addRun = useAgentStore((state) => state.addRun);
  const updateRun = useAgentStore((state) => state.updateRun);
  const addTrace = useExecutionStore((state) => state.addTrace);
  const addNode = useExecutionStore((state) => state.addNode);
  const updateNode = useExecutionStore((state) => state.updateNode);

  useEffect(() => {
    if (!lastServerMessage) return;

    const message = lastServerMessage;

    console.log('[useExecutionMessages] Received message:', message.type, message);

    // Type narrowing using discriminated union based on message.type
    switch (message.type) {
      case 'execution.start': {
        const trace: ExecutionTrace = message.trace;
        const agentId: string = message.agentId;

        // Create a run from the trace
        const run: Run = {
          id: trace.traceId,
          agentId,
          startTime: trace.startTime,
          endTime: null,
          durationMs: null,
          status: 'running',
          input: {},
          inputPreview: '',
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

        addRun(agentId, run);
        addTrace(trace);
        break;
      }

      case 'execution.complete': {
        const agentId: string = message.agentId;
        const traceId: string = message.traceId;
        const summary = message.summary;

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
  }, [
    lastServerMessage,
    addRun,
    updateRun,
    addTrace,
    addNode,
    updateNode,
  ]);
}
