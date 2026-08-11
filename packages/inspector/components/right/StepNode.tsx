'use client';

/**
 * One node on the workflow canvas.
 *
 * Kind is carried by a glyph and a label, never by colour alone — a plan can
 * hold a dozen kinds, and a dozen hues is noise. Colour marks one thing: what
 * the node does to control flow. Steps do work and sit on the surface, gates
 * route it and wear an accent edge, terminals are small and quiet.
 */

import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { GraphNodeKind } from '../../lib/workflow-graph';
import type { StepFlowNode } from '../../lib/workflow-layout';
import { FlowDirection, Handles } from '../../lib/workflow-layout';

/** A short mark per kind. Read together with the label, never instead of it. */
const GLYPHS: Record<GraphNodeKind, string> = {
  callModel: '✦',
  invokeTool: '⚙',
  runCode: '⌘',
  sequence: '↓',
  inParallel: '⋔',
  join: '⋏',
  conditional: '◇',
  loop: '↻',
  schedule: '⏱',
  spawn: '⧉',
  withContext: '◫',
  subflow: '⧈',
  'claude-code': '⌥',
  codex: '⌥',
  opencode: '⌥',
  pi: '⌥',
  start: '●',
  end: '◼',
  malformed: '⚠',
};

export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const { node, direction } = data;
  const flowing = direction === FlowDirection.Down;
  const inPosition = flowing ? Position.Top : Position.Left;
  const outPosition = flowing ? Position.Bottom : Position.Right;
  const backPosition = flowing ? Position.Right : Position.Bottom;

  const handles = (
    <>
      <Handle
        type="target"
        id={Handles.In}
        position={inPosition}
        className="!size-1.5 !bg-line-strong !border-0"
      />
      <Handle
        type="source"
        id={Handles.Out}
        position={outPosition}
        className="!size-1.5 !bg-line-strong !border-0"
      />
      <Handle
        type="target"
        id={Handles.BackIn}
        position={backPosition}
        className="!size-1.5 !bg-line-strong !border-0"
      />
      <Handle
        type="source"
        id={Handles.BackOut}
        position={backPosition}
        className="!size-1.5 !bg-line-strong !border-0"
      />
    </>
  );

  if (node.shape === 'terminal') {
    return (
      <div className="flex h-full items-center justify-center rounded-full bg-inset px-3 font-mono text-[10.5px] text-ink-2 shadow-hairline">
        {handles}
        <span aria-hidden className="mr-1">
          {GLYPHS[node.kind]}
        </span>
        {node.title}
      </div>
    );
  }

  const gate = node.shape === 'gate';
  return (
    <div
      // The layout gave this node a fixed box; overflow-hidden keeps content
      // that outgrows it from spilling over the neighbour dagre placed next to it.
      className={`flex h-full flex-col justify-center overflow-hidden rounded-card bg-surface px-2.5 py-1.5 text-left shadow-card ${
        gate ? 'border-l-2 border-accent' : ''
      } ${selected ? 'ring-1 ring-accent' : ''} ${node.ref ? 'cursor-pointer' : ''}`}
      title={node.ref ? `Open workflow "${node.ref}"` : node.detail}
    >
      {handles}
      <div className="flex items-baseline gap-1.5">
        <span aria-hidden className="text-[11px] text-ink-3">
          {GLYPHS[node.kind]}
        </span>
        <span className="font-mono text-[11.5px] font-medium text-ink">{node.title}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-ink-3">
          {node.id}
        </span>
      </div>
      {node.detail !== undefined && (
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-2">{node.detail}</p>
      )}
      {node.chips.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {node.chips.map((chip) => (
            <span
              key={chip}
              className="rounded-chip bg-inset px-1.5 py-px font-mono text-[9.5px] text-ink-2 shadow-hairline"
            >
              {chip}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
