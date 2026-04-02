/**
 * Node Graph Canvas Component
 * Main graph visualization component using custom SVG rendering
 * Supports pan, zoom, selection, and hierarchical layout
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { routeEdge } from '../lib/edge-router';
import { calculateSequentialLayout, fitToViewport } from '../lib/sequential-layout';
import { ensureMap } from '../lib/serialization';
import type { ExecutionNode, ExecutionTrace, NodeEdge, NodePosition, Waypoint } from '../types';
import { BranchNode, ForkNode, LLMNode, LoopNode, RunNode, SpawnNode, ToolNode } from './nodes';
import {
  EDGE_CORNER_RADIUS,
  EDGE_STYLES,
  NODE_KIND_COLORS,
  STATUS_COLORS,
  STEP_KIND_ICONS,
  STEP_KIND_LABELS,
} from './nodes/shared';

interface NodeGraphProps {
  trace: ExecutionTrace | null;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
  fitToView?: boolean;
  /** Node IDs that have been "executed" up to the current timeline position */
  executedNodeIds?: Set<string>;
}

interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

interface DragState {
  isDragging: boolean;
  startX: number;
  startY: number;
  initialX: number;
  initialY: number;
}

const NODE_WIDTH = 280;
const NODE_HEIGHT = 140;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;

/** Build SVG path from orthogonal waypoints with rounded corners */
const buildPolylinePath = (waypoints: Waypoint[], radius: number): string => {
  if (waypoints.length < 2) {
    return '';
  }
  if (waypoints.length === 2) {
    return `M ${waypoints[0].x} ${waypoints[0].y} L ${waypoints[1].x} ${waypoints[1].y}`;
  }

  const parts: string[] = [
    `M ${waypoints[0].x} ${waypoints[0].y}`,
  ];

  for (let i = 1; i < waypoints.length - 1; i++) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];
    const next = waypoints[i + 1];

    // Distance to prev and next points
    const dPrev = Math.max(Math.abs(curr.x - prev.x), Math.abs(curr.y - prev.y));
    const dNext = Math.max(Math.abs(next.x - curr.x), Math.abs(next.y - curr.y));
    const r = Math.min(radius, dPrev / 2, dNext / 2);

    // Direction vectors
    const fromX = Math.sign(curr.x - prev.x);
    const fromY = Math.sign(curr.y - prev.y);
    const toX = Math.sign(next.x - curr.x);
    const toY = Math.sign(next.y - curr.y);

    // Arc start and end
    const arcStartX = curr.x - fromX * r;
    const arcStartY = curr.y - fromY * r;
    const arcEndX = curr.x + toX * r;
    const arcEndY = curr.y + toY * r;

    // Determine sweep direction
    const cross = fromX * toY - fromY * toX;
    const sweep = cross > 0 ? 1 : 0;

    parts.push(`L ${arcStartX} ${arcStartY}`);
    parts.push(`A ${r} ${r} 0 0 ${sweep} ${arcEndX} ${arcEndY}`);
  }

  const last = waypoints[waypoints.length - 1];
  parts.push(`L ${last.x} ${last.y}`);

  return parts.join(' ');
};

export const NodeGraph: React.FC<NodeGraphProps> = ({
  trace,
  selectedNodeId: externalSelectedNodeId,
  onNodeSelect,
  fitToView = true,
  executedNodeIds,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // Use internal state if no external control provided
  const [internalSelectedNodeId, setInternalSelectedNodeId] = useState<string | null>(null);
  const selectedNodeId = externalSelectedNodeId ?? internalSelectedNodeId;
  const handleNodeSelect = useCallback(
    (nodeId: string | null) => {
      setInternalSelectedNodeId(nodeId);
      onNodeSelect?.(nodeId);
    },
    [
      onNodeSelect,
    ],
  );

  const [view, setView] = useState<ViewState>({
    x: 0,
    y: 0,
    zoom: 1,
  });
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    startX: 0,
    startY: 0,
    initialX: 0,
    initialY: 0,
  });
  const [isPanning, setIsPanning] = useState(false);

  // Calculate layout whenever trace changes
  const { positions, edges, nodes } = useMemo(() => {
    if (!trace) {
      return {
        positions: [],
        edges: [],
        nodes: new Map<string, ExecutionNode>(),
      };
    }

    // Ensure trace.nodes is a Map (handles both serialized and deserialized data)
    const nodeMap = ensureMap<string, ExecutionNode>(trace.nodes);

    console.log('[NodeGraph] Rendering with:', {
      traceId: trace.traceId,
      rootNodeId: trace.rootNodeId,
      nodeMapSize: nodeMap.size,
      hasRootNode: nodeMap.has(trace.rootNodeId),
      traceNodesIsMap: trace.nodes instanceof Map,
      traceNodesType: typeof trace.nodes,
      sampleKeys: Array.from(nodeMap.keys()).slice(0, 3),
    });

    const { positions, edges } = calculateSequentialLayout(nodeMap, trace.rootNodeId, {
      nodeWidth: NODE_WIDTH,
      nodeHeight: NODE_HEIGHT,
    });

    return {
      positions,
      edges,
      nodes: nodeMap,
    };
  }, [
    trace,
  ]);

  // Fit to viewport on initial load
  useEffect(() => {
    if (fitToView && positions.length > 0 && containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      const fit = fitToViewport({
        positions,
        viewportWidth: width,
        viewportHeight: height,
        padding: 50,
      });
      setView(fit);
    }
  }, [
    positions,
    fitToView,
  ]);

  // Pan handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 0 || e.button === 1) {
        // Left or middle mouse button
        setDragState({
          isDragging: true,
          startX: e.clientX,
          startY: e.clientY,
          initialX: view.x,
          initialY: view.y,
        });
        setIsPanning(true);
      }
    },
    [
      view.x,
      view.y,
    ],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragState.isDragging) {
        const dx = (e.clientX - dragState.startX) / view.zoom;
        const dy = (e.clientY - dragState.startY) / view.zoom;
        setView((prev) => ({
          ...prev,
          x: dragState.initialX + dx,
          y: dragState.initialY + dy,
        }));
      }
    },
    [
      dragState,
      view.zoom,
    ],
  );

  const handleMouseUp = useCallback(() => {
    setDragState((prev) => ({
      ...prev,
      isDragging: false,
    }));
    setIsPanning(false);
  }, []);

  // Zoom handler
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (!containerRef.current) {
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Calculate mouse position in graph space before zoom
      const graphX = (mouseX - view.x) / view.zoom;
      const graphY = (mouseY - view.y) / view.zoom;

      // Calculate new zoom
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * delta));

      // Calculate new view position to keep mouse over same graph point
      const newX = mouseX - graphX * newZoom;
      const newY = mouseY - graphY * newZoom;

      setView({
        x: newX,
        y: newY,
        zoom: newZoom,
      });
    },
    [
      view,
    ],
  );

  // Node selection
  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (selectedNodeId === nodeId) {
        handleNodeSelect(null);
      } else {
        handleNodeSelect(nodeId);
      }
    },
    [
      selectedNodeId,
      handleNodeSelect,
    ],
  );

  // Fit to view button handler
  const handleFitToView = useCallback(() => {
    if (positions.length > 0 && containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      const fit = fitToViewport({
        positions,
        viewportWidth: width,
        viewportHeight: height,
        padding: 50,
      });
      setView(fit);
    }
  }, [
    positions,
  ]);

  // Render node component based on kind
  const renderNode = (node: ExecutionNode) => {
    const isGhosted = executedNodeIds !== undefined && !executedNodeIds.has(node.id);
    const displayNode = isGhosted
      ? {
          ...node,
          status: 'pending' as const,
        }
      : node;
    const commonProps = {
      node: displayNode,
      selected: selectedNodeId === node.id,
      onClick: () => handleNodeClick(node.id),
    };

    switch (node.kind) {
      case 'run': {
        return <RunNode {...commonProps} />;
      }
      case 'llm': {
        return <LLMNode {...commonProps} />;
      }
      case 'tool': {
        return <ToolNode {...commonProps} />;
      }
      case 'branch': {
        return <BranchNode {...commonProps} />;
      }
      case 'fork': {
        return <ForkNode {...commonProps} />;
      }
      case 'spawn': {
        return <SpawnNode {...commonProps} />;
      }
      case 'loop': {
        return <LoopNode {...commonProps} />;
      }
      default: {
        return <RunNode {...commonProps} />;
      }
    }
  };

  // Render edge
  const renderEdge = (edge: NodeEdge, sourcePos: NodePosition, targetPos: NodePosition) => {
    const obstaclePositions = positions.filter((p) => p.id !== edge.source && p.id !== edge.target);
    const routed = routeEdge(sourcePos, targetPos, obstaclePositions);
    const path = buildPolylinePath(routed.waypoints, EDGE_CORNER_RADIUS);

    const edgeStyle = EDGE_STYLES[edge.type] ?? EDGE_STYLES.default;

    // For default edges, use source node status color
    let strokeColor = edgeStyle.color;
    if (edge.type === 'default') {
      const sourceNode = nodes.get(edge.source);
      const isEdgeGhosted =
        executedNodeIds !== undefined &&
        (!executedNodeIds.has(edge.source) || !executedNodeIds.has(edge.target));
      const effectiveStatus = isEdgeGhosted ? 'pending' : sourceNode?.status;
      strokeColor = effectiveStatus ? STATUS_COLORS[effectiveStatus].border : edgeStyle.color;
    }

    return (
      <g key={edge.id}>
        {/* Arrow marker definition */}
        <defs>
          <marker
            id={`arrow-${edge.id}`}
            viewBox="0 0 10 8"
            refX="10"
            refY="4"
            markerWidth="8"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <polyline points="0,0 10,4 0,8" fill="none" stroke={strokeColor} strokeWidth="1.5" />
          </marker>
        </defs>
        <path
          d={path}
          fill="none"
          stroke={strokeColor}
          strokeWidth={edgeStyle.strokeWidth}
          strokeDasharray={edgeStyle.strokeDasharray}
          markerEnd={`url(#arrow-${edge.id})`}
        />
        {edge.animated && (
          <circle r="3" fill={strokeColor}>
            <animateMotion dur="1s" repeatCount="indefinite" path={path} />
          </circle>
        )}
      </g>
    );
  };

  // Build position lookup map
  const positionMap = useMemo(() => {
    const map = new Map<string, NodePosition>();
    for (const pos of positions) {
      map.set(pos.id, pos);
    }
    return map;
  }, [
    positions,
  ]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Node graph canvas for execution visualization"
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: 'var(--noetic-bg)',
        backgroundImage: `
          radial-gradient(circle, var(--noetic-grid-color) 1px, transparent 1px)
        `,
        backgroundSize: '20px 20px',
        overflow: 'hidden',
        cursor: isPanning ? 'grabbing' : 'grab',
        position: 'relative',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      {/* Controls */}
      <div
        style={{
          position: 'absolute',
          top: '16px',
          right: '16px',
          display: 'flex',
          gap: '8px',
          zIndex: 10,
        }}
      >
        <button
          type="button"
          onClick={handleFitToView}
          style={{
            padding: '8px 12px',
            backgroundColor: 'var(--noetic-canvas-bg)',
            border: '1px solid var(--noetic-border)',
            borderRadius: '4px',
            color: 'var(--noetic-text)',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          Fit to View
        </button>
        <div
          style={{
            padding: '8px 12px',
            backgroundColor: 'var(--noetic-canvas-bg)',
            border: '1px solid var(--noetic-border)',
            borderRadius: '4px',
            color: 'var(--noetic-text-secondary)',
            fontSize: '12px',
          }}
        >
          {Math.round(view.zoom * 100)}%
        </div>
      </div>

      {/* Info overlay */}
      {trace && (
        <div
          style={{
            position: 'absolute',
            top: '16px',
            left: '16px',
            padding: '12px',
            backgroundColor: 'var(--noetic-node-bg)',
            border: '1px solid var(--noetic-border)',
            borderRadius: '4px',
            color: 'var(--noetic-text)',
            fontSize: '12px',
            zIndex: 10,
          }}
        >
          <div>Trace: {trace.traceId.slice(0, 8)}...</div>
          <div>Status: {trace.status}</div>
          <div>Nodes: {trace.nodes.size}</div>
        </div>
      )}

      {/* Graph canvas */}
      <div
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          transformOrigin: '0 0',
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      >
        {/* SVG edges layer - sized dynamically based on content */}
        <svg
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            overflow: 'visible',
          }}
        >
          <title>Node graph edges showing execution flow connections</title>
          {edges.map((edge) => {
            const sourcePos = positionMap.get(edge.source);
            const targetPos = positionMap.get(edge.target);
            if (!sourcePos || !targetPos) {
              return null;
            }
            return renderEdge(edge, sourcePos, targetPos);
          })}
        </svg>

        {/* Container layer — rendered behind child nodes */}
        {positions
          .filter((pos) => pos.isContainer)
          .map((pos) => {
            const node = nodes.get(pos.id);
            if (!node) {
              return null;
            }
            const kindColors = NODE_KIND_COLORS[node.kind] ?? NODE_KIND_COLORS.run;
            const statusColors = STATUS_COLORS[node.status] ?? STATUS_COLORS.pending;
            const icon = STEP_KIND_ICONS[node.kind] ?? '';
            const label = STEP_KIND_LABELS[node.kind] ?? node.kind;
            return (
              <div
                key={`container-${pos.id}`}
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y,
                  width: pos.width,
                  height: pos.height,
                  borderRadius: '12px',
                  border: `2px dashed ${kindColors.border}`,
                  backgroundColor: `${kindColors.bg}`,
                  pointerEvents: 'none',
                  transformOrigin: 'top left',
                }}
              >
                {/* Container header */}
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: `${36 * (pos.scale ?? 1)}px`,
                    borderRadius: '10px 10px 0 0',
                    backgroundColor: kindColors.border,
                    display: 'flex',
                    alignItems: 'center',
                    gap: `${6 * (pos.scale ?? 1)}px`,
                    padding: `0 ${12 * (pos.scale ?? 1)}px`,
                    color: '#fff',
                    fontSize: `${12 * (pos.scale ?? 1)}px`,
                    fontWeight: 600,
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                  }}
                >
                  <span>{icon}</span>
                  <span>{label}</span>
                  <span
                    style={{
                      opacity: 0.7,
                      fontWeight: 400,
                    }}
                  >
                    {node.stepId}
                  </span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      opacity: 0.8,
                      fontSize: '11px',
                    }}
                  >
                    {statusColors.text ? node.status : ''}
                  </span>
                </div>
              </div>
            );
          })}

        {/* Node layer — leaf nodes rendered on top of containers */}
        {positions
          .filter((pos) => !pos.isContainer)
          .map((pos) => {
            const node = nodes.get(pos.id);
            if (!node) {
              return null;
            }
            return (
              <div
                key={pos.id}
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y,
                  width: pos.width,
                  height: pos.height,
                  pointerEvents: 'auto',
                  transform: pos.scale && pos.scale !== 1 ? `scale(${pos.scale})` : undefined,
                  transformOrigin: 'top left',
                }}
              >
                {renderNode(node)}
              </div>
            );
          })}
      </div>

      {/* Empty state */}
      {!trace && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            color: 'var(--noetic-text-muted)',
          }}
        >
          <div
            style={{
              fontSize: '48px',
              marginBottom: '16px',
            }}
          >
            📊
          </div>
          <div
            style={{
              fontSize: '18px',
              marginBottom: '8px',
            }}
          >
            No execution trace
          </div>
          <div
            style={{
              fontSize: '14px',
            }}
          >
            Select a run from the sidebar to view execution flow
          </div>
        </div>
      )}
    </div>
  );
};

export default NodeGraph;
