/**
 * Node Graph Canvas Component
 * Main graph visualization component using custom SVG rendering
 * Supports pan, zoom, selection, and hierarchical layout
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { calculateHierarchicalLayout, fitToViewport } from '../lib/layout';
import type { ExecutionNode, ExecutionTrace, NodeEdge, NodePosition } from '../types';
import { BranchNode, ForkNode, LLMNode, LoopNode, RunNode, SpawnNode, ToolNode } from './nodes';
import { NODE_KIND_COLORS, STATUS_COLORS } from './nodes/shared';

interface NodeGraphProps {
  trace: ExecutionTrace | null;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
  onNodeDeselect?: () => void;
  fitToView?: boolean;
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

export const NodeGraph: React.FC<NodeGraphProps> = ({
  trace,
  selectedNodeId = null,
  onNodeSelect,
  onNodeDeselect,
  fitToView = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
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

    const { positions, edges } = calculateHierarchicalLayout(trace.nodes, trace.rootNodeId, {
      nodeWidth: NODE_WIDTH,
      nodeHeight: NODE_HEIGHT,
      levelSpacing: 200,
      siblingSpacing: 40,
    });

    return {
      positions,
      edges,
      nodes: trace.nodes,
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
        onNodeDeselect?.();
      } else {
        onNodeSelect?.(nodeId);
      }
    },
    [
      selectedNodeId,
      onNodeSelect,
      onNodeDeselect,
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
    const commonProps = {
      node,
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
    const startX = sourcePos.x + sourcePos.width / 2;
    const startY = sourcePos.y + sourcePos.height;
    const endX = targetPos.x + targetPos.width / 2;
    const endY = targetPos.y;

    // Calculate control points for bezier curve
    const midY = (startY + endY) / 2;
    const path = `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;

    const sourceNode = nodes.get(edge.source);
    const color = sourceNode
      ? STATUS_COLORS[sourceNode.status].border
      : NODE_KIND_COLORS.run.border;

    return (
      <g key={edge.id}>
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeDasharray={edge.type === 'conditional' ? '5,5' : undefined}
        />
        {edge.animated && (
          <circle r="4" fill={color}>
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
        backgroundColor: '#0f172a',
        backgroundImage: `
          radial-gradient(circle, #334155 1px, transparent 1px)
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
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '4px',
            color: '#f1f5f9',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          Fit to View
        </button>
        <div
          style={{
            padding: '8px 12px',
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '4px',
            color: '#94a3b8',
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
            backgroundColor: 'rgba(15, 23, 42, 0.8)',
            border: '1px solid #334155',
            borderRadius: '4px',
            color: '#f1f5f9',
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
        {/* SVG edges layer */}
        <svg
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '10000px',
            height: '10000px',
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

        {/* Node layer */}
        {positions.map((pos) => {
          const node = nodes.get(pos.id);
          if (!node) {
            return null;
          }

          return (
            <button
              key={pos.id}
              type="button"
              style={{
                position: 'absolute',
                left: pos.x,
                top: pos.y,
                pointerEvents: 'auto',
                background: 'none',
                border: 'none',
                padding: 0,
                margin: 0,
                cursor: 'pointer',
              }}
              onClick={(e) => {
                e.stopPropagation();
                handleNodeClick(pos.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  handleNodeClick(pos.id);
                }
              }}
            >
              {renderNode(node)}
            </button>
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
            color: '#64748b',
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
