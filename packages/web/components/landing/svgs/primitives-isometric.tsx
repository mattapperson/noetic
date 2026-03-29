import type { ReactNode } from 'react';

const GREEN = '#39ff14';
const CYAN = '#38bdf8';
const AMBER = '#ffb000';
const SURFACE = '#080808';

function NodeFaces({
  x,
  y,
  w,
  h,
  depth,
  color,
  label,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  color: string;
  label: string;
}): ReactNode {
  const rx = x + w;
  const by = y + h;
  return (
    <g>
      <polygon
        points={`${x},${y} ${x + depth},${y - depth} ${rx + depth},${y - depth} ${rx},${y}`}
        fill={SURFACE}
        stroke={color}
        strokeWidth="0.8"
        strokeOpacity="0.6"
      />
      <rect x={x} y={y} width={w} height={h} fill={SURFACE} stroke={color} strokeWidth="0.8" />
      <rect x={x} y={y} width={w} height={h} fill={color} fillOpacity="0" stroke="none">
        <animate
          attributeName="fill-opacity"
          values="0;0.06;0"
          dur="3s"
          begin="0s"
          repeatCount="indefinite"
          calcMode="ease"
        />
      </rect>
      <polygon
        points={`${rx},${y} ${rx + depth},${y - depth} ${rx + depth},${by - depth} ${rx},${by}`}
        fill={SURFACE}
        stroke={color}
        strokeWidth="0.8"
        strokeOpacity="0.6"
      />
      <text
        x={x + w / 2}
        y={y + h / 2 + 5}
        textAnchor="middle"
        fill={color}
        fontSize="11"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
        letterSpacing="0.08em"
      >
        {label}
      </text>
    </g>
  );
}

function GlowSphere({
  color,
  gradientId,
  path,
  dur,
  begin,
}: {
  color: string;
  gradientId: string;
  path: string;
  dur: string;
  begin: string;
}): ReactNode {
  return (
    <g>
      <circle r="9" fill={`url(#${gradientId})`} />
      <circle r="2.5" fill={color} />
      {/* @ts-ignore SVG SMIL animateMotion path attribute */}
      <animateMotion
        path={path}
        dur={dur}
        begin={begin}
        repeatCount="indefinite"
        calcMode="linear"
      />
    </g>
  );
}

export function PrimitivesIsometricSvg(): ReactNode {
  const wireLlmTool = 'M130,108 L225,118';
  const wireLoopBack = 'M335,138 L335,232 L15,232 L15,108';

  return (
    <svg
      viewBox="0 0 460 240"
      width="100%"
      height="100%"
      role="img"
      aria-label="Data flow: llm calls tool inside a loop; the loop feeds back to llm"
      style={{
        maxHeight: '240px',
      }}
    >
      <defs>
        <filter id="prim-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
        <radialGradient id="prim-glow-green" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={GREEN} stopOpacity="0.8" />
          <stop offset="100%" stopColor={GREEN} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="prim-glow-cyan" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={CYAN} stopOpacity="0.8" />
          <stop offset="100%" stopColor={CYAN} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="prim-glow-amber" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={AMBER} stopOpacity="0.8" />
          <stop offset="100%" stopColor={AMBER} stopOpacity="0" />
        </radialGradient>
        <marker
          id="prim-arrow-green"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="1,1 9,5 1,9" stroke={GREEN} strokeWidth="1.5" fill="none" />
        </marker>
        <marker
          id="prim-arrow-cyan"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="1,1 9,5 1,9" stroke={CYAN} strokeWidth="1.5" fill="none" />
        </marker>
        <marker
          id="prim-arrow-amber"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="1,1 9,5 1,9" stroke={AMBER} strokeWidth="1.5" fill="none" />
        </marker>
      </defs>

      {/* Loop boundary container */}
      <rect
        x={185}
        y={4}
        width={262}
        height={228}
        fill={CYAN}
        fillOpacity="0.02"
        stroke={CYAN}
        strokeWidth="0.8"
        strokeOpacity="0.35"
        strokeDasharray="6 4"
      />
      <text
        x={316}
        y={20}
        textAnchor="middle"
        fill={CYAN}
        fontSize="8"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
        letterSpacing="0.08em"
        opacity="0.6"
      >
        LOOP ↻
      </text>

      {/* Wires */}
      <path
        d={wireLlmTool}
        fill="none"
        stroke={AMBER}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#prim-arrow-amber)"
      />
      <path
        d={wireLoopBack}
        fill="none"
        stroke={CYAN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        strokeDasharray="4 3"
        markerEnd="url(#prim-arrow-cyan)"
      />

      {/* Nodes */}
      <NodeFaces x={20} y={88} w={110} h={40} depth={12} color={GREEN} label="llm" />
      <NodeFaces x={225} y={98} w={110} h={40} depth={12} color={AMBER} label="tool" />

      {/* Spheres — llm→tool */}
      <GlowSphere
        color={AMBER}
        gradientId="prim-glow-amber"
        path={wireLlmTool}
        dur="2.5s"
        begin="0s"
      />
      <GlowSphere
        color={AMBER}
        gradientId="prim-glow-amber"
        path={wireLlmTool}
        dur="2.5s"
        begin="1.25s"
      />
      {/* Spheres — loop feedback */}
      <GlowSphere
        color={CYAN}
        gradientId="prim-glow-cyan"
        path={wireLoopBack}
        dur="4s"
        begin="0s"
      />
      <GlowSphere
        color={CYAN}
        gradientId="prim-glow-cyan"
        path={wireLoopBack}
        dur="4s"
        begin="2s"
      />
    </svg>
  );
}
