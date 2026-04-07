import type { ReactNode } from 'react';

const GREEN = '#39ff14';
const CYAN = '#38bdf8';
const AMBER = '#ffb000';
const MUTED = '#475569';
const SURFACE = '#080808';
const BORDER_COLOR = '#1a1a1a';

// Grid: minimum 28px spacing ensures 25px+ line segments
const NODE_W = 72;
const NODE_H = 36;
const NODE_D = 10;
const MIN_SEGMENT = 28; // Minimum 28px (exceeds 25px requirement)

interface NodeProps {
  x: number;
  y: number;
  color: string;
  label: string;
  muted?: boolean;
}

function PrimitiveNode({ x, y, color, label, muted }: NodeProps): ReactNode {
  const w = NODE_W;
  const h = NODE_H;
  const d = NODE_D;
  const rx = x + w;
  const by = y + h;

  return (
    <g>
      {/* Top face */}
      <polygon
        points={`${x},${y} ${x + d},${y - d} ${rx + d},${y - d} ${rx},${y}`}
        fill={SURFACE}
        stroke={color}
        strokeWidth="0.8"
        strokeOpacity={muted ? '0.5' : '0.7'}
      />
      {/* Front face */}
      <rect x={x} y={y} width={w} height={h} fill={SURFACE} stroke={color} strokeWidth="0.8" />
      {/* Pulse animation */}
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
      {/* Right face */}
      <polygon
        points={`${rx},${y} ${rx + d},${y - d} ${rx + d},${by - d} ${rx},${by}`}
        fill={SURFACE}
        stroke={color}
        strokeWidth="0.8"
        strokeOpacity={muted ? '0.5' : '0.7'}
      />
      {/* Label */}
      <text
        x={x + w / 2}
        y={y + h / 2 + 4}
        textAnchor="middle"
        fill={color}
        fontSize="11"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
        letterSpacing="0.06em"
      >
        {label}
      </text>
    </g>
  );
}

function MemoryLayer({
  x,
  y,
  w,
  h,
  d,
  label,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  d: number;
  label: string;
}): ReactNode {
  const rx = x + w;
  const midY = y + h / 2;

  return (
    <g>
      {/* Top face */}
      <polygon
        points={`${x},${y} ${x + d},${y - d} ${rx + d},${y - d} ${rx},${y}`}
        fill={SURFACE}
        stroke={BORDER_COLOR}
        strokeWidth="0.8"
      />
      {/* Front face */}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={SURFACE}
        stroke={BORDER_COLOR}
        strokeWidth="0.8"
      />
      {/* Pulse animation */}
      <rect x={x} y={y} width={w} height={h} fill={GREEN} fillOpacity="0" stroke="none">
        <animate
          attributeName="fill-opacity"
          values="0;0.04;0"
          dur="3s"
          begin="0s"
          repeatCount="indefinite"
          calcMode="ease"
        />
      </rect>
      {/* Right face */}
      <polygon
        points={`${rx},${y} ${rx + d},${y - d} ${rx + d},${y + h - d} ${rx},${y + h}`}
        fill={SURFACE}
        stroke={BORDER_COLOR}
        strokeWidth="0.8"
      />
      {/* Label */}
      <text
        x={x + w / 2}
        y={midY + 1}
        textAnchor="middle"
        fill="#94a3b8"
        fontSize="8"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
        letterSpacing="0.06em"
      >
        {label.toUpperCase()}
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
      <circle r="8" fill={`url(#${gradientId})`} />
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
  // ReAct Loop: Thought → Action → Observation → (loop back) → Thought
  // All connecting segments must be ≥ 28px (exceeds 25px requirement)

  // Pattern box dimensions with proper padding
  const patternPad = 10;
  const labelHeight = 36; // Space for 2 lines of text

  // Pattern box dimensions - moved up 10px, but nodes stay in place
  const patternX = 120;
  const patternY = 30; // Moved up from 40
  const patternW = 248;
  const patternH = 180;

  // Node positions - kept in same place by adding 10px offset
  // llm positioned so patternEntry → llm = 28px
  const llmPos = {
    x: patternX + MIN_SEGMENT,
    y: patternY + labelHeight + patternPad + 10, // +10 to keep node in same position
  };

  // tool positioned so llm → tool = 28px and tool → patternExit = 28px
  // moved 20px to the right total (10px + 10px)
  const toolPos = {
    x: llmPos.x + NODE_W + MIN_SEGMENT + 20,
    y: patternY + labelHeight + patternPad + 10,
  };

  // Observation centered below
  const memX = llmPos.x + (toolPos.x - llmPos.x) / 2 - NODE_W / 2;
  const memY = llmPos.y + NODE_H + MIN_SEGMENT * 1.5;
  const memW = NODE_W;
  const memH = 28;
  const memD = 8;

  // Connection points
  const llmRight = {
    x: llmPos.x + NODE_W,
    y: llmPos.y + NODE_H / 2,
  };
  const llmLeft = {
    x: llmPos.x,
    y: llmPos.y + NODE_H / 2,
  };
  const _llmTop = {
    x: llmPos.x + NODE_W / 2,
    y: llmPos.y,
  };
  const llmBottom = {
    x: llmPos.x + NODE_W / 2,
    y: llmPos.y + NODE_H,
  };
  const toolLeft = {
    x: toolPos.x,
    y: toolPos.y + NODE_H / 2,
  };
  const toolRight = {
    x: toolPos.x + NODE_W,
    y: toolPos.y + NODE_H / 2,
  };
  const toolBottom = {
    x: toolPos.x + NODE_W / 2,
    y: toolPos.y + NODE_H,
  };
  const memTop = {
    x: memX + memW / 2,
    y: memY,
  };
  const _memBottom = {
    x: memX + memW / 2,
    y: memY + memH,
  };
  const memRight = {
    x: memX + memW,
    y: memY + memH / 2,
  };

  // Pattern entry/exit positioned for 28px segments
  const patternEntry = {
    x: patternX,
    y: llmLeft.y,
  };
  const patternExit = {
    x: patternX + patternW,
    y: toolRight.y,
  };

  // External nodes positioned for 28px segments
  // inputRight to patternEntry = 28px
  // inputRight = patternEntry.x - 28 = 120 - 28 = 92
  // inputPos.x = 92 - 72 = 20
  const inputPos = {
    x: patternEntry.x - NODE_W - MIN_SEGMENT,
    y: llmPos.y,
  };
  const inputRight = {
    x: inputPos.x + NODE_W,
    y: patternEntry.y,
  };

  // patternExit to outputLeft = 28px
  // outputLeft = patternExit.x + 28 = 368 + 28 = 396
  // outputPos.x = 396
  const outputPos = {
    x: patternExit.x + MIN_SEGMENT,
    y: toolPos.y,
  };
  const outputLeft = {
    x: outputPos.x,
    y: patternExit.y,
  };

  // Wire paths - all segments ≥ 28px
  // input → pattern entry: 28px horizontal
  const wireInputPattern = `M${inputRight.x},${inputRight.y} L${patternEntry.x},${patternEntry.y}`;

  // pattern entry → llm: 28px horizontal
  const wireEntryLlm = `M${patternEntry.x},${patternEntry.y} L${llmLeft.x},${llmLeft.y}`;

  // llm → tool: 28px horizontal
  const wireLlmTool = `M${llmRight.x},${llmRight.y} L${toolLeft.x},${toolLeft.y}`;

  // tool → memory: 45° down-left to right side of observe node
  const toolToMemDelta = 36; // 45° diagonal > 28px minimum
  const toolToMemTurnX = toolBottom.x - toolToMemDelta;
  const toolToMemTurnY = toolBottom.y + toolToMemDelta;
  const wireToolMem = `M${toolBottom.x},${toolBottom.y} L${toolToMemTurnX},${toolToMemTurnY} L${memRight.x},${memRight.y}`;

  // memory → llm: straight vertical up, ending at llm bottom edge (not top)
  // This prevents orbs from going "into" the node
  const wireMemLlm = `M${memTop.x},${memTop.y} L${llmBottom.x},${llmBottom.y}`;

  // tool → pattern exit: 28px horizontal
  const wireToolExit = `M${toolRight.x},${toolRight.y} L${patternExit.x},${patternExit.y}`;

  // pattern exit → output: 28px horizontal
  const wireExitOutput = `M${patternExit.x},${patternExit.y} L${outputLeft.x},${outputLeft.y}`;

  // ViewBox
  const minX = 16;
  const maxX = 520;
  const minY = 8;
  const maxY = 240;

  return (
    <svg
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="ReAct loop: Thought → Action → Observation → loop back to Thought"
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
          <polyline points="5,1 9,5 5,9" stroke={GREEN} strokeWidth="0.8" fill="none" />
        </marker>
        <marker
          id="pat-arrow-cyan"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="5,1 9,5 5,9" stroke={CYAN} strokeWidth="0.8" fill="none" />
        </marker>
        <marker
          id="pat-arrow-amber"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="5,1 9,5 5,9" stroke={AMBER} strokeWidth="0.8" fill="none" />
        </marker>
        <marker
          id="pat-arrow-muted"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="5,1 9,5 5,9" stroke={MUTED} strokeWidth="0.8" fill="none" />
        </marker>
      </defs>

      {/* Pattern boundary */}
      <rect
        x={patternX}
        y={patternY}
        width={patternW}
        height={patternH}
        fill={GREEN}
        fillOpacity="0.02"
        stroke={GREEN}
        strokeWidth="1"
        strokeOpacity="0.4"
        strokeDasharray="6 4"
      />
      {/* Label */}
      <text
        x={patternX + 12}
        y={patternY + 16}
        textAnchor="start"
        fill={GREEN}
        fontSize="9"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
        letterSpacing="0.06em"
        opacity="0.7"
      >
        ReAct pattern
      </text>
      <text
        x={patternX + 12}
        y={patternY + 28}
        textAnchor="start"
        fill={GREEN}
        fontSize="7"
        fontFamily="JetBrains Mono, monospace"
        opacity="0.5"
      >
        thought → action → observe
      </text>

      {/* Wires - all segments ≥ 28px, arrow heads match stroke colors */}
      <path
        d={wireInputPattern}
        fill="none"
        stroke={MUTED}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#pat-arrow-muted)"
      />
      <path
        d={wireEntryLlm}
        fill="none"
        stroke={GREEN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#pat-arrow-green)"
      />
      <path
        d={wireLlmTool}
        fill="none"
        stroke={GREEN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#pat-arrow-green)"
      />
      <path
        d={wireMemLlm}
        fill="none"
        stroke={AMBER}
        strokeWidth="0.8"
        strokeOpacity="0.45"
        strokeDasharray="4 3"
        markerEnd="url(#pat-arrow-amber)"
      />
      <path
        d={wireToolExit}
        fill="none"
        stroke={CYAN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#pat-arrow-cyan)"
      />
      <path
        d={wireExitOutput}
        fill="none"
        stroke={GREEN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#pat-arrow-green)"
      />

      {/* Nodes */}
      <PrimitiveNode x={inputPos.x} y={inputPos.y} color={MUTED} label="input" muted />
      <PrimitiveNode x={llmPos.x} y={llmPos.y} color={GREEN} label="thought" />
      <PrimitiveNode x={toolPos.x} y={toolPos.y} color={CYAN} label="action" />
      <MemoryLayer x={memX} y={memY} w={memW} h={memH} d={memD} label="observe" />

      {/* Action → Observe wire rendered AFTER memory node so arrow is visible on top */}
      <path
        d={wireToolMem}
        fill="none"
        stroke={CYAN}
        strokeWidth="1"
        strokeOpacity="0.7"
        markerEnd="url(#pat-arrow-cyan)"
      />

      {/* Output circle */}
      <circle
        cx={outputPos.x + NODE_W / 2}
        cy={outputPos.y + NODE_H / 2}
        r={18}
        fill={SURFACE}
        stroke={GREEN}
        strokeWidth="0.8"
      />
      <circle
        cx={outputPos.x + NODE_W / 2}
        cy={outputPos.y + NODE_H / 2}
        r={18}
        fill={GREEN}
        fillOpacity="0.05"
        stroke="none"
      >
        <animate
          attributeName="fill-opacity"
          values="0.03;0.1;0.03"
          dur="2.5s"
          begin="0s"
          repeatCount="indefinite"
          calcMode="ease"
        />
      </circle>
      <text
        x={outputPos.x + NODE_W / 2}
        y={outputPos.y + NODE_H / 2 - 2}
        textAnchor="middle"
        fill={GREEN}
        fontSize="12"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
      >
        ✓
      </text>
      <text
        x={outputPos.x + NODE_W / 2}
        y={outputPos.y + NODE_H / 2 + 10}
        textAnchor="middle"
        fill={GREEN}
        fontSize="7.5"
        fontFamily="JetBrains Mono, monospace"
        opacity="0.7"
      >
        answer
      </text>

      {/* Animated spheres */}
      <GlowSphere
        color={MUTED}
        gradientId="pat-glow-green"
        path={wireInputPattern}
        dur="3s"
        begin="0s"
      />
      <GlowSphere
        color={GREEN}
        gradientId="pat-glow-green"
        path={wireEntryLlm}
        dur="2.5s"
        begin="0.3s"
      />
      <GlowSphere
        color={GREEN}
        gradientId="pat-glow-green"
        path={wireLlmTool}
        dur="2.5s"
        begin="0.6s"
      />
      <GlowSphere
        color={CYAN}
        gradientId="pat-glow-cyan"
        path={wireToolMem}
        dur="2.5s"
        begin="0.9s"
      />
      <GlowSphere color={AMBER} gradientId="pat-glow-amber" path={wireMemLlm} dur="3s" begin="0s" />
      <GlowSphere
        color={AMBER}
        gradientId="pat-glow-amber"
        path={wireMemLlm}
        dur="3s"
        begin="1.5s"
      />
      <GlowSphere
        color={CYAN}
        gradientId="pat-glow-cyan"
        path={wireToolExit}
        dur="2.5s"
        begin="1.2s"
      />
      <GlowSphere
        color={GREEN}
        gradientId="pat-glow-green"
        path={wireExitOutput}
        dur="2.5s"
        begin="1.5s"
      />
    </svg>
  );
}
