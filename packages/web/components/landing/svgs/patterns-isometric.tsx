import type { ReactNode } from 'react';

const GREEN = '#39ff14';
const CYAN = '#38bdf8';
const AMBER = '#ffb000';
const SURFACE = '#080808';

function MiniNode({
  x,
  y,
  color,
  label,
}: {
  x: number;
  y: number;
  color: string;
  label: string;
}): ReactNode {
  const W = 64;
  const H = 28;
  const D = 10;
  return (
    <g>
      <polygon
        points={`${x},${y} ${x + D},${y - D} ${x + W + D},${y - D} ${x + W},${y}`}
        fill={SURFACE}
        stroke={color}
        strokeWidth="0.8"
        strokeOpacity="0.6"
      />
      <rect x={x} y={y} width={W} height={H} fill={SURFACE} stroke={color} strokeWidth="0.8" />
      <rect x={x} y={y} width={W} height={H} fill={color} fillOpacity="0" stroke="none">
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
        points={`${x + W},${y} ${x + W + D},${y - D} ${x + W + D},${y + H - D} ${x + W},${y + H}`}
        fill={SURFACE}
        stroke={color}
        strokeWidth="0.8"
        strokeOpacity="0.6"
      />
      <text
        x={x + W / 2}
        y={y + H / 2 + 4}
        textAnchor="middle"
        fill={color}
        fontSize="10"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
      >
        {label}
      </text>
    </g>
  );
}

function PatternNode(): ReactNode {
  const x = 280;
  const y = 90;
  const W = 110;
  const H = 44;
  const D = 14;
  return (
    <g>
      <polygon
        points={`${x},${y} ${x + D},${y - D} ${x + W + D},${y - D} ${x + W},${y}`}
        fill={SURFACE}
        stroke={GREEN}
        strokeWidth="1"
        strokeOpacity="0.7"
      />
      <rect x={x} y={y} width={W} height={H} fill={SURFACE} stroke={GREEN} strokeWidth="1" />
      <rect x={x} y={y} width={W} height={H} fill={GREEN} fillOpacity="0" stroke="none">
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
        points={`${x + W},${y} ${x + W + D},${y - D} ${x + W + D},${y + H - D} ${x + W},${y + H}`}
        fill={SURFACE}
        stroke={GREEN}
        strokeWidth="1"
        strokeOpacity="0.7"
      />
      <text
        x={x + W / 2}
        y={y + H / 2 + 4}
        textAnchor="middle"
        fill={GREEN}
        fontSize="11"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
      >
        pattern
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

export function PatternsIsometricSvg(): ReactNode {
  const wireLlm = 'M84,44 L164,44 L234,114 L280,114';
  const wireTool = 'M84,114 L280,114';
  const wireRun = 'M84,184 L164,184 L234,114 L280,114';
  const wireOut = 'M390,112 L440,112';

  return (
    <svg
      viewBox="0 0 480 240"
      width="100%"
      height="100%"
      role="img"
      aria-label="Three primitive nodes (llm, tool, run) with wires converging into a pattern node, which outputs a result"
      style={{
        maxHeight: '240px',
      }}
    >
      <defs>
        <filter id="pat-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
        <radialGradient id="pat-glow-green" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={GREEN} stopOpacity="0.8" />
          <stop offset="100%" stopColor={GREEN} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="pat-glow-cyan" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={CYAN} stopOpacity="0.8" />
          <stop offset="100%" stopColor={CYAN} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="pat-glow-amber" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={AMBER} stopOpacity="0.8" />
          <stop offset="100%" stopColor={AMBER} stopOpacity="0" />
        </radialGradient>
        <marker
          id="pat-arrow-green"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="1,1 9,5 1,9" stroke={GREEN} strokeWidth="1.5" fill="none" />
        </marker>
      </defs>

      {/* Wires */}
      <path
        d={wireLlm}
        fill="none"
        stroke={GREEN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#pat-arrow-green)"
      />
      <path
        d={wireTool}
        fill="none"
        stroke={CYAN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#pat-arrow-green)"
      />
      <path
        d={wireRun}
        fill="none"
        stroke={AMBER}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#pat-arrow-green)"
      />
      <path
        d={wireOut}
        fill="none"
        stroke={GREEN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#pat-arrow-green)"
      />

      {/* Mini nodes */}
      <MiniNode x={20} y={30} color={GREEN} label="llm" />
      <MiniNode x={20} y={100} color={CYAN} label="tool" />
      <MiniNode x={20} y={170} color={AMBER} label="run" />

      {/* Pattern node */}
      <PatternNode />

      {/* Result label */}
      <text
        x={448}
        y={109}
        fill={GREEN}
        fontSize="10"
        fontFamily="JetBrains Mono, monospace"
        opacity="0.7"
      >
        result
      </text>

      {/* Spheres */}
      <GlowSphere color={GREEN} gradientId="pat-glow-green" path={wireLlm} dur="2.5s" begin="0s" />
      <GlowSphere
        color={GREEN}
        gradientId="pat-glow-green"
        path={wireLlm}
        dur="2.5s"
        begin="1.25s"
      />
      <GlowSphere color={CYAN} gradientId="pat-glow-cyan" path={wireTool} dur="2s" begin="0.4s" />
      <GlowSphere color={CYAN} gradientId="pat-glow-cyan" path={wireTool} dur="2s" begin="1.4s" />
      <GlowSphere
        color={AMBER}
        gradientId="pat-glow-amber"
        path={wireRun}
        dur="2.5s"
        begin="0.8s"
      />
      <GlowSphere
        color={AMBER}
        gradientId="pat-glow-amber"
        path={wireRun}
        dur="2.5s"
        begin="2.05s"
      />
      <GlowSphere color={GREEN} gradientId="pat-glow-green" path={wireOut} dur="1.5s" begin="1s" />
    </svg>
  );
}
