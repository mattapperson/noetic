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
  STATUS_ICONS,
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

interface ZoomEntry {
  containerId: string;
  label: string;
  previousView: ViewState;
}

const NODE_WIDTH = 280;
const NODE_HEIGHT = 140;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;

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
  /** Tracks the last node ID we panned to — avoids re-centering when only the
   *  layout changes (e.g. live trace updates) but the selection hasn't. */
  const lastPannedToRef = useRef<string | null>(null);
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
  const nodeClickedRef = useRef(false);
  const wasDragRef = useRef(false);
  const [zoomStack, setZoomStack] = useState<ZoomEntry[]>([]);

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

  const handleZoomBack = useCallback(() => {
    setZoomStack((prev) => {
      if (prev.length === 0) {
        return prev;
      }
      const last = prev[prev.length - 1];
      setView(last.previousView);
      return prev.slice(0, -1);
    });
  }, []);

  // Pan handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 0 || e.button === 1) {
        nodeClickedRef.current = false;
        wasDragRef.current = false;
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
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          wasDragRef.current = true;
        }
        setView((prev) => ({
          ...prev,
          x: dragState.initialX + dx,
          y: dragState.initialY + dy,
        }));
      }
    },
    [
      dragState,
    ],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const wasDrag =
        dragState.isDragging &&
        (Math.abs(e.clientX - dragState.startX) > 3 || Math.abs(e.clientY - dragState.startY) > 3);
      setDragState((prev) => ({
        ...prev,
        isDragging: false,
      }));
      setIsPanning(false);

      // Click on background (no drag, no node clicked)
      if (!wasDrag && !nodeClickedRef.current) {
        handleNodeSelect(null);
        if (zoomStack.length > 0) {
          handleZoomBack();
        }
      }
    },
    [
      dragState,
      zoomStack,
      handleZoomBack,
      handleNodeSelect,
    ],
  );

  // Zoom handler ��� attached as a non-passive native listener so
  // preventDefault works (React onWheel is passive by default).
  const handleWheel = useCallback(
    (e: WheelEvent) => {
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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    el.addEventListener('wheel', handleWheel, {
      passive: false,
    });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [
    handleWheel,
  ]);

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

  // Pan to center the externally selected node (e.g. from timeline click).
  // Skips if we already panned to this node — prevents re-centering when the
  // layout recalculates (live updates) but the selection hasn't changed.
  useEffect(() => {
    if (!externalSelectedNodeId || !containerRef.current) {
      return;
    }
    if (externalSelectedNodeId === lastPannedToRef.current) {
      return;
    }
    const pos = positionMap.get(externalSelectedNodeId);
    if (!pos) {
      return;
    }
    lastPannedToRef.current = externalSelectedNodeId;
    const { width, height } = containerRef.current.getBoundingClientRect();
    const graphCenterX = pos.x + pos.width / 2;
    const graphCenterY = pos.y + pos.height / 2;
    setView((prev) => ({
      ...prev,
      x: width / 2 - graphCenterX * prev.zoom,
      y: height / 2 - graphCenterY * prev.zoom,
    }));
  }, [
    externalSelectedNodeId,
    positionMap,
  ]);

  // Shared helper: zoom to a target, anchored on a graph-space point
  const zoomTo = useCallback(
    (graphX: number, graphY: number, targetZoom: number) => {
      const screenX = graphX * view.zoom + view.x;
      const screenY = graphY * view.zoom + view.y;
      setView({
        x: screenX - graphX * targetZoom,
        y: screenY - graphY * targetZoom,
        zoom: targetZoom,
      });
    },
    [
      view,
    ],
  );

  // Push a container onto the breadcrumb stack (if not already there)
  const pushBreadcrumb = useCallback(
    (containerId: string) => {
      const node = nodes.get(containerId);
      if (!node) {
        return;
      }
      // Already the current breadcrumb
      if (zoomStack.length > 0 && zoomStack[zoomStack.length - 1].containerId === containerId) {
        return;
      }
      setZoomStack((prev) => [
        ...prev,
        {
          containerId,
          label: `${STEP_KIND_LABELS[node.kind]} ${node.stepId}`,
          previousView: {
            ...view,
          },
        },
      ]);
    },
    [
      nodes,
      view,
      zoomStack,
    ],
  );

  // Node selection + zoom to make the node full size
  const handleNodeClick = useCallback(
    (nodeId: string) => {
      // Ignore clicks that are the end of a pan gesture
      if (wasDragRef.current) {
        return;
      }
      nodeClickedRef.current = true;
      handleNodeSelect(nodeId);

      // If the node is scaled down (nested), zoom so it renders at 100%
      const pos = positionMap.get(nodeId);
      if (!pos) {
        return;
      }
      const nodeScale = pos.scale ?? 1;
      if (nodeScale >= 1) {
        return;
      }
      const targetZoom = Math.min(1 / nodeScale, MAX_ZOOM);
      if (Math.abs(targetZoom - view.zoom) < 0.05) {
        return;
      }

      // Push parent container to breadcrumb so background click zooms back
      const node = nodes.get(nodeId);
      if (node?.parentId) {
        pushBreadcrumb(node.parentId);
      }

      const graphCenterX = pos.x + pos.width / 2;
      const graphCenterY = pos.y + pos.height / 2;
      zoomTo(graphCenterX, graphCenterY, targetZoom);
    },
    [
      handleNodeSelect,
      positionMap,
      nodes,
      view,
      zoomTo,
      pushBreadcrumb,
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

  // Compute SVG canvas size from node positions so edges render correctly
  const svgBounds = useMemo(() => {
    if (positions.length === 0) {
      return {
        width: 0,
        height: 0,
      };
    }
    let maxX = 0;
    let maxY = 0;
    for (const pos of positions) {
      maxX = Math.max(maxX, pos.x + pos.width);
      maxY = Math.max(maxY, pos.y + pos.height);
    }
    // Add margin for edge routing and arrow markers
    return {
      width: maxX + 200,
      height: maxY + 200,
    };
  }, [
    positions,
  ]);

  const handleContainerZoom = useCallback(
    (containerId: string) => {
      if (wasDragRef.current) {
        return;
      }
      nodeClickedRef.current = true;
      const pos = positionMap.get(containerId);
      const node = nodes.get(containerId);
      if (!pos || !node || !containerRef.current) {
        return;
      }

      // If this container is already in the breadcrumb stack, zoom back to it
      const existingIndex = zoomStack.findIndex((e) => e.containerId === containerId);
      if (existingIndex !== -1) {
        const target = zoomStack[existingIndex];
        setView(target.previousView);
        setZoomStack((prev) => prev.slice(0, existingIndex));
        return;
      }

      // Don't re-zoom into the container we're already looking at
      if (zoomStack.length > 0 && zoomStack[zoomStack.length - 1].containerId === containerId) {
        return;
      }

      // Zoom so children render at full size: invert the nesting scale
      const containerScale = pos.scale ?? 1;
      const targetZoom = Math.min(1 / containerScale, MAX_ZOOM);

      // Skip if zoom wouldn't meaningfully change (e.g. root container at depth 0)
      if (Math.abs(targetZoom - view.zoom) < 0.05) {
        return;
      }

      pushBreadcrumb(containerId);

      const graphCenterX = pos.x + pos.width / 2;
      const graphCenterY = pos.y + pos.height / 2;
      zoomTo(graphCenterX, graphCenterY, targetZoom);
    },
    [
      positionMap,
      nodes,
      view,
      zoomStack,
      zoomTo,
      pushBreadcrumb,
    ],
  );

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

    // Counter-scale stroke widths so lines stay thin at any zoom level
    const counterScale = 1 / view.zoom;
    const scaledStrokeWidth = edgeStyle.strokeWidth * counterScale;
    // Arrow size in graph-space pixels (userSpaceOnUse keeps it zoom-independent)
    const arrowSize = 8 * counterScale;

    return (
      <g key={edge.id}>
        {/* Arrow marker — 45-degree chevron, zoom-independent size */}
        <defs>
          <marker
            id={`arrow-${edge.id}`}
            viewBox="0 0 8 8"
            refX="8"
            refY="4"
            markerUnits="userSpaceOnUse"
            markerWidth={arrowSize}
            markerHeight={arrowSize}
            orient="auto-start-reverse"
          >
            <polyline points="0,0 8,4 0,8" fill="none" stroke={strokeColor} strokeWidth="1.5" />
          </marker>
        </defs>
        <path
          d={path}
          fill="none"
          stroke={strokeColor}
          strokeWidth={scaledStrokeWidth}
          strokeDasharray={edgeStyle.strokeDasharray}
          markerEnd={`url(#arrow-${edge.id})`}
        />
      </g>
    );
  };

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
      onMouseLeave={() => {
        // Only stop an active pan — do NOT deselect the node or zoom back
        if (dragState.isDragging) {
          setDragState((prev) => ({
            ...prev,
            isDragging: false,
          }));
          setIsPanning(false);
          wasDragRef.current = false;
        }
      }}
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

      {/* Breadcrumb navigation */}
      {zoomStack.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '56px',
            right: '16px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            zIndex: 10,
            padding: '6px 12px',
            backgroundColor: 'var(--noetic-canvas-bg)',
            border: '1px solid var(--noetic-border)',
            borderRadius: '4px',
            fontSize: '12px',
            color: 'var(--noetic-text)',
          }}
        >
          <button
            type="button"
            onClick={handleZoomBack}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--noetic-text)',
              cursor: 'pointer',
              padding: '2px 6px',
              fontSize: '12px',
            }}
          >
            Root
          </button>
          {zoomStack.map((entry, i) => (
            <span
              key={entry.containerId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <span
                style={{
                  opacity: 0.5,
                }}
              >
                /
              </span>
              <button
                type="button"
                onClick={() => {
                  const target = zoomStack[i];
                  setView(target.previousView);
                  setZoomStack((prev) => prev.slice(0, i));
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color:
                    i === zoomStack.length - 1
                      ? 'var(--noetic-text)'
                      : 'var(--noetic-text-secondary)',
                  cursor: 'pointer',
                  padding: '2px 6px',
                  fontSize: '12px',
                  fontWeight: i === zoomStack.length - 1 ? 600 : 400,
                }}
              >
                {entry.label}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Graph canvas */}
      <div
        style={
          {
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            transformOrigin: '0 0',
            transition: isPanning ? 'none' : 'transform 0.3s ease-out',
            position: 'absolute',
            top: 0,
            left: 0,
            // Expose counter-scale factor so descendant nodes can keep borders thin
            '--line-scale': 1 / view.zoom,
          } as React.CSSProperties
        }
      >
        {/* SVG edges layer - sized to cover all nodes so paths render */}
        <svg
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${svgBounds.width}px`,
            height: `${svgBounds.height}px`,
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

        {/* Container layer — rendered behind child nodes (skip root, it wraps everything) */}
        {positions
          .filter((pos) => pos.isContainer && pos.id !== trace?.rootNodeId)
          .map((pos) => {
            const node = nodes.get(pos.id);
            if (!node) {
              return null;
            }
            const kindColors = NODE_KIND_COLORS[node.kind] ?? NODE_KIND_COLORS.run;
            const statusColors = STATUS_COLORS[node.status] ?? STATUS_COLORS.pending;
            const icon = STEP_KIND_ICONS[node.kind] ?? '';
            const label = STEP_KIND_LABELS[node.kind] ?? node.kind;
            // Counter-scale border so it stays thin at any zoom level
            const borderWidth = 1 / view.zoom;
            return (
              <button
                key={`container-${pos.id}`}
                type="button"
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y,
                  width: pos.width,
                  height: pos.height,
                  borderRadius: '4px',
                  border: `${borderWidth}px dashed ${kindColors.border}`,
                  backgroundColor: `${kindColors.bg}`,
                  pointerEvents: 'auto',
                  cursor: 'pointer',
                  transformOrigin: 'top left',
                  padding: 0,
                }}
                onClick={() => handleContainerZoom(pos.id)}
              >
                {/* Container header */}
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    borderRadius: '3px 3px 0 0',
                    overflow: 'hidden',
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                  }}
                >
                  {/* Row 1: type + status icon */}
                  <div
                    style={{
                      backgroundColor: `${kindColors.border}99`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: `${6 * (pos.scale ?? 1)}px`,
                      padding: `${6 * (pos.scale ?? 1)}px ${12 * (pos.scale ?? 1)}px`,
                      color: '#fff',
                      fontSize: `${12 * (pos.scale ?? 1)}px`,
                      fontWeight: 600,
                    }}
                  >
                    <span>{icon}</span>
                    <span>{label}</span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        color: statusColors.text,
                      }}
                    >
                      {STATUS_ICONS[node.status]}
                    </span>
                  </div>
                  {/* Row 2: name */}
                  <div
                    style={{
                      backgroundColor: `${kindColors.border}4D`,
                      padding: `${4 * (pos.scale ?? 1)}px ${12 * (pos.scale ?? 1)}px`,
                      color: '#ffffffcc',
                      fontSize: `${10 * (pos.scale ?? 1)}px`,
                      fontWeight: 400,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {node.stepId}
                  </div>
                </div>
              </button>
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
