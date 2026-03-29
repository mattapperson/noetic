import type { ReactNode } from 'react';

const GREEN = '#39ff14';
const CYAN = '#38bdf8';
const SURFACE = '#080808';
const BORDER_COLOR = '#1a1a1a';

const LAYER_X = 110;
const LAYER_W = 258;
const LAYER_H = 32;
const LAYER_D = 12;
const LAYER_SPACING = 48;
const WRITE_X = 90;
const READ_X = 390;
const WIRE_TOP_Y = 18;
const WIRE_BOTTOM_Y = 254;

const LAYERS = [
  {
    name: 'working memory',
    desc: 'current turn',
  },
  {
    name: 'observational',
    desc: 'auto-extracted facts',
  },
  {
    name: 'semantic recall',
    desc: 'vector store',
  },
  {
    name: 'episodic',
    desc: 'conversation summaries',
  },
  {
    name: 'durable state',
    desc: 'agent checkpoints',
  },
] as const;

function LayerPanel({ index }: { index: number }): ReactNode {
  const y = 30 + index * LAYER_SPACING;
  const rx = LAYER_X + LAYER_W;
  const midY = y + LAYER_H / 2;

  return (
    <g>
      <polygon
        points={`${LAYER_X},${y} ${LAYER_X + LAYER_D},${y - LAYER_D} ${rx + LAYER_D},${y - LAYER_D} ${rx},${y}`}
        fill={SURFACE}
        stroke={BORDER_COLOR}
        strokeWidth="0.8"
      />
      <rect
        x={LAYER_X}
        y={y}
        width={LAYER_W}
        height={LAYER_H}
        fill={SURFACE}
        stroke={BORDER_COLOR}
        strokeWidth="0.8"
      />
      <rect
        x={LAYER_X}
        y={y}
        width={LAYER_W}
        height={LAYER_H}
        fill={GREEN}
        fillOpacity="0"
        stroke="none"
      >
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
        points={`${rx},${y} ${rx + LAYER_D},${y - LAYER_D} ${rx + LAYER_D},${y + LAYER_H - LAYER_D} ${rx},${y + LAYER_H}`}
        fill={SURFACE}
        stroke={BORDER_COLOR}
        strokeWidth="0.8"
      />
      <text
        x={LAYER_X + LAYER_W / 2}
        y={midY + 1}
        textAnchor="middle"
        fill="#94a3b8"
        fontSize="9"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
        letterSpacing="0.06em"
      >
        {LAYERS[index].name.toUpperCase()}
      </text>
      <text
        x={LAYER_X + LAYER_W / 2}
        y={midY + 12}
        textAnchor="middle"
        fill="#475569"
        fontSize="7.5"
        fontFamily="JetBrains Mono, monospace"
      >
        {LAYERS[index].desc}
      </text>
      {/* Connector to write wire */}
      <line
        x1={LAYER_X}
        y1={midY}
        x2={WRITE_X}
        y2={midY}
        stroke={GREEN}
        strokeWidth="0.5"
        strokeOpacity="0.3"
      />
      {/* Connector to read wire */}
      <line
        x1={rx}
        y1={midY}
        x2={READ_X}
        y2={midY}
        stroke={CYAN}
        strokeWidth="0.5"
        strokeOpacity="0.3"
      />
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

function LlmBox(): ReactNode {
  const bx = 408;
  const by = 8;
  const bw = 72;
  const bh = 28;
  const bd = 10;
  return (
    <g>
      <polygon
        points={`${bx},${by} ${bx + bd},${by - bd} ${bx + bw + bd},${by - bd} ${bx + bw},${by}`}
        fill={SURFACE}
        stroke={CYAN}
        strokeWidth="0.8"
        strokeOpacity="0.6"
      />
      <rect x={bx} y={by} width={bw} height={bh} fill={SURFACE} stroke={CYAN} strokeWidth="0.8" />
      <polygon
        points={`${bx + bw},${by} ${bx + bw + bd},${by - bd} ${bx + bw + bd},${by + bh - bd} ${bx + bw},${by + bh}`}
        fill={SURFACE}
        stroke={CYAN}
        strokeWidth="0.8"
        strokeOpacity="0.6"
      />
      <text
        x={bx + bw / 2}
        y={by + 11}
        textAnchor="middle"
        fill={CYAN}
        fontSize="8"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
      >
        LLM
      </text>
      <text
        x={bx + bw / 2}
        y={by + 22}
        textAnchor="middle"
        fill={CYAN}
        fontSize="6.5"
        fontFamily="JetBrains Mono, monospace"
        opacity="0.7"
      >
        assembleView()
      </text>
      {/* Connect LLM box to read wire */}
      <line
        x1={bx}
        y1={by + bh / 2}
        x2={READ_X}
        y2={by + bh / 2}
        stroke={CYAN}
        strokeWidth="0.5"
        strokeOpacity="0.4"
      />
    </g>
  );
}

export function MemoryIsometricSvg(): ReactNode {
  const writeDownPath = `M${WRITE_X},${WIRE_TOP_Y} L${WRITE_X},${WIRE_BOTTOM_Y}`;
  const readUpPath = `M${READ_X},${WIRE_BOTTOM_Y} L${READ_X},${WIRE_TOP_Y}`;

  return (
    <svg
      viewBox="0 -14 500 314"
      width="100%"
      height="auto"
      role="img"
      aria-label="Five stacked memory layers. A green write wire propagates data down through all layers. A cyan read wire assembles context upward into an LLM node."
      style={{
        display: 'block',
      }}
    >
      <defs>
        <filter id="mem-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
        <radialGradient id="mem-glow-green" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={GREEN} stopOpacity="0.8" />
          <stop offset="100%" stopColor={GREEN} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mem-glow-cyan" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={CYAN} stopOpacity="0.8" />
          <stop offset="100%" stopColor={CYAN} stopOpacity="0" />
        </radialGradient>
        <marker
          id="mem-arrow-green"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="1,1 9,5 1,9" stroke={GREEN} strokeWidth="1.5" fill="none" />
        </marker>
        <marker
          id="mem-arrow-cyan"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="1,1 9,5 1,9" stroke={CYAN} strokeWidth="1.5" fill="none" />
        </marker>
      </defs>

      {/* Write wire (green, top → bottom) */}
      <line
        x1={WRITE_X}
        y1={WIRE_TOP_Y}
        x2={WRITE_X}
        y2={WIRE_BOTTOM_Y}
        stroke={GREEN}
        strokeWidth="0.8"
        strokeOpacity="0.4"
        markerEnd="url(#mem-arrow-green)"
      />
      {/* Read wire (cyan, bottom → top) */}
      <line
        x1={READ_X}
        y1={WIRE_BOTTOM_Y}
        x2={READ_X}
        y2={WIRE_TOP_Y}
        stroke={CYAN}
        strokeWidth="0.8"
        strokeOpacity="0.4"
        markerEnd="url(#mem-arrow-cyan)"
      />

      {/* Wire labels */}
      <text
        x={WRITE_X}
        y={12}
        textAnchor="middle"
        fill={GREEN}
        fontSize="8"
        fontFamily="JetBrains Mono, monospace"
        opacity="0.7"
      >
        write ↓
      </text>
      <text
        x={READ_X}
        y={12}
        textAnchor="middle"
        fill={CYAN}
        fontSize="8"
        fontFamily="JetBrains Mono, monospace"
        opacity="0.7"
      >
        ↑ read
      </text>

      {/* Layer panels */}
      {(
        [
          0,
          1,
          2,
          3,
          4,
        ] as const
      ).map((i) => (
        <LayerPanel key={i} index={i} />
      ))}

      {/* LLM box */}
      <LlmBox />

      {/* Token savings callout */}
      <text
        x={(LAYER_X * 2 + LAYER_W) / 2}
        y={275}
        textAnchor="middle"
        fill="#475569"
        fontSize="8"
        fontFamily="JetBrains Mono, monospace"
      >
        raw history ≈ 6,000 tok → assembled context ≈ 680 tok
      </text>

      {/* Spheres — write (down) */}
      <GlowSphere
        color={GREEN}
        gradientId="mem-glow-green"
        path={writeDownPath}
        dur="4s"
        begin="0s"
      />
      <GlowSphere
        color={GREEN}
        gradientId="mem-glow-green"
        path={writeDownPath}
        dur="4s"
        begin="2s"
      />
      {/* Spheres — read (up) */}
      <GlowSphere color={CYAN} gradientId="mem-glow-cyan" path={readUpPath} dur="4s" begin="1s" />
      <GlowSphere color={CYAN} gradientId="mem-glow-cyan" path={readUpPath} dur="4s" begin="3s" />
    </svg>
  );
}
