'use client';

/**
 * Hook to process WebSocket execution messages and update agent store
 * Single source of truth: agent store for all persistent data
 */

import { useEffect } from 'react';
import type { ExecutionNode, ExecutionTrace, ServerMessage } from '../../shared/protocol';
import { ensureMap } from '../lib/serialization';
import { useAgentStore } from '../stores/agent';
import { useExecutionStore } from '../stores/execution';
import { registerMessageHandler } from '../stores/websocket';
import type { Run } from '../types/agent';

export function useExecutionMessages(): void {
  const addRun = useAgentStore((state) => state.addRun);
  const updateRun = useAgentStore((state) => state.updateRun);
  const addAgent = useAgentStore((state) => state.addAgent);
  const updateNode = useExecutionStore((state) => state.updateNode);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    console.debug('[useExecutionMessages] Registering handler');

    const handler = (message: ServerMessage) => {
      console.debug('[useExecutionMessages] Processing message:', message.type);

      switch (message.type) {
        case 'execution.start': {
          const trace: ExecutionTrace = message.trace;
          const agentId: string = message.agentId;

          // Ensure agent exists before adding run
          const agentExists = useAgentStore.getState().agents.some((a) => a.id === agentId);
          if (!agentExists) {
            console.debug('[useExecutionMessages] Creating agent for run:', agentId);
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

          console.debug('[useExecutionMessages] Adding run:', run.id, 'for agent:', agentId);
          addRun(agentId, run);
          break;
        }

        case 'execution.complete': {
          const agentId: string = message.agentId;
          const traceId: string = message.traceId;
          const summary = message.summary;

          console.debug('[useExecutionMessages] Completing run:', traceId);
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

          console.error('[useExecutionMessages] Error in run:', traceId);
          updateRun(agentId, traceId, {
            status: 'error',
            endTime: Date.now(),
            isLive: false,
          });
          break;
        }

        case 'node.start': {
          const { node } = message;
          // Find the live run for this node and update it
          const agentState = useAgentStore.getState();
          for (const agent of agentState.agents) {
            const liveRun = agent.runs.find((r) => r.isLive);
            if (!liveRun) {
              continue;
            }
            const existingTrace = liveRun.trace;
            if (!existingTrace) {
              continue;
            }
            const nodeMap = ensureMap<string, ExecutionNode>(existingTrace.nodes);
            nodeMap.set(node.id, node);

            // Wire parent-child relationship
            if (node.parentId) {
              const parent = nodeMap.get(node.parentId);
              if (parent && !parent.children.includes(node.id)) {
                parent.children = [
                  ...parent.children,
                  node.id,
                ];
                nodeMap.set(parent.id, parent);
              }
            }

            // Set root if not set
            if (!existingTrace.rootNodeId && !node.parentId) {
              agentState.updateRun(agent.id, liveRun.id, {
                trace: {
                  ...existingTrace,
                  nodes: nodeMap,
                  rootNodeId: node.id,
                },
              });
            } else {
              agentState.updateRun(agent.id, liveRun.id, {
                trace: {
                  ...existingTrace,
                  nodes: nodeMap,
                },
              });
            }
            break;
          }
          break;
        }

        case 'node.complete':
        case 'node.error': {
          // Update node in execution store cache
          const nodeId = message.nodeId;
          if (message.type === 'node.complete') {
            updateNode(nodeId, {
              output: message.output,
              durationMs: message.durationMs,
              endTime: Date.now(),
              status: 'completed',
            });
          } else {
            updateNode(nodeId, {
              error: message.error,
              endTime: Date.now(),
              status: 'error',
            });
          }
          break;
        }

        case 'execution.list.response': {
          for (const agent of message.agents) {
            const exists = useAgentStore.getState().agents.some((a) => a.id === agent.agentId);
            if (!exists) {
              addAgent({
                id: agent.agentId,
                name: agent.name,
                filePath: '',
                exportName: '',
                discoveredAt: Date.now(),
                lastModified: Date.now(),
                discoveryMethod: 'runtime',
                runs: [],
                runCount: agent.runCount,
                lastRunAt: null,
              });
            }
          }
          break;
        }

        default:
          break;
      }
    };

    return registerMessageHandler(handler);
  }, [
    addRun,
    updateRun,
    addAgent,
    updateNode,
  ]);
}
