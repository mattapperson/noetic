import type { ReactNode } from 'react';

const GREEN = '#39ff14';
const CYAN = '#38bdf8';
const AMBER = '#ffb000';
const MUTED = '#475569';
const SURFACE = '#080808';

// Grid system: 28px minimum spacing ensures 25px+ line segments
// Horizontal = 28px, Diagonal = 28*sqrt(2) ≈ 40px
const NODE_W = 72;
const NODE_H = 36;
const NODE_D = 10;
const SPACING = 28; // Minimum 28px between connection points

interface NodeProps {
  x: number;
  y: number;
  color: string;
  label: string;
  muted?: boolean;
}

function IsometricNode({ x, y, color, label, muted }: NodeProps): ReactNode {
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
      {/* Pulse animation on front face */}
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

export function PrimitivesIsometricSvg(): ReactNode {
  // Layout with minimum 28px spacing between all connection points
  // All angles are exactly 45° or 90° (London Underground style)

  // LLM node - central anchor
  const llmPos = {
    x: 152,
    y: 96,
  };
  const llmRight = {
    x: llmPos.x + NODE_W,
    y: llmPos.y + NODE_H / 2,
  }; // (224, 114)

  // Tool node: 45° up-right from llm
  // From llmRight (224, 114), horizontal by SPACING to (252, 114)
  // Then 45° up-right by 36px to (252+36, 114-36) = (288, 78) = toolLeft
  // toolPos = (288, 78-18) = (288, 60)
  const toolPos = {
    x: 288,
    y: 60,
  };
  const toolLeft = {
    x: toolPos.x,
    y: toolPos.y + NODE_H / 2,
  }; // (288, 78)

  // Run node: 45° down-right from llm
  // Same horizontal, then 45° down-right: (252+36, 114+36) = (288, 150) = runLeft
  // runPos = (288, 150-18) = (288, 132)
  const runPos = {
    x: 288,
    y: 132,
  };
  const runLeft = {
    x: runPos.x,
    y: runPos.y + NODE_H / 2,
  }; // (288, 150)

  // Loop boundary - 28px padding from nodes + 10px additional padding
  const loopPad = 38; // 28 + 10 = 38px from node edges
  const loopLeft = llmPos.x - loopPad; // 152 - 38 = 114
  const loopTop = toolPos.y - loopPad; // 60 - 38 = 22
  const loopRight = runPos.x + NODE_W + loopPad; // 288 + 72 + 38 = 398
  const loopBottom = runPos.y + NODE_H + loopPad; // 132 + 36 + 38 = 206
  const loopCenterY = (loopTop + loopBottom) / 2; // (22 + 206) / 2 = 114

  // Prompt node - left of loop, 28px gap from loop entry
  // loopEntry at x=114, prompt ends at x=114-28=86
  const promptPos = {
    x: 14,
    y: loopCenterY - NODE_H / 2,
  }; // (14, 96)
  const promptRight = {
    x: promptPos.x + NODE_W,
    y: loopCenterY,
  }; // (86, 114)

  // Until node - right of loop, 28px gap from loop exit
  // loopExit at x=398, until starts at x=398+28=426
  const untilPos = {
    x: 426,
    y: loopCenterY - NODE_H / 2,
  }; // (426, 96)
  const untilLeft = {
    x: untilPos.x,
    y: loopCenterY,
  }; // (426, 114)

  // Loop connection points
  const loopEntry = {
    x: loopLeft,
    y: loopCenterY,
  }; // (114, 114)
  const loopExit = {
    x: loopRight,
    y: loopCenterY,
  }; // (398, 114)

  // Internal connection points
  const llmLeft = {
    x: llmPos.x,
    y: llmPos.y + NODE_H / 2,
  }; // (152, 114)
  const llmTop = {
    x: llmPos.x + NODE_W / 2,
    y: llmPos.y,
  }; // (188, 96)

  // Wire paths - all segments minimum 28px, angles exactly 45° or 90°

  // prompt → loop entry: horizontal (86→114 = 28px)
  const wirePromptLoop = `M${promptRight.x},${promptRight.y} L${loopEntry.x},${loopEntry.y}`;

  // loop entry → llm: horizontal (114→152 = 38px)
  const wireEntryLlm = `M${loopEntry.x},${loopEntry.y} L${llmLeft.x},${llmLeft.y}`;

  // loop exit → until: horizontal (398→426 = 28px)
  const wireLoopExit = `M${loopExit.x},${loopExit.y} L${untilLeft.x},${untilLeft.y}`;

  // llm → tool: horizontal (224→252 = 28px), then 45° up-right (36px each direction)
  const midToolX = llmRight.x + SPACING; // 252
  const wireLlmTool = `M${llmRight.x},${llmRight.y} L${midToolX},${llmRight.y} L${toolLeft.x},${toolLeft.y}`;

  // llm → run: horizontal (224→252 = 28px), then 45° down-right
  const midRunX = llmRight.x + SPACING; // 252
  const wireLlmRun = `M${llmRight.x},${llmRight.y} L${midRunX},${llmRight.y} L${runLeft.x},${runLeft.y}`;

  // tool → llm (loop back): horizontal left (60px), then 45° down-left
  // From toolLeft (288, 78), go left by 60 to (228, 78), then 45° down-left to llmTop area
  const turnX = toolLeft.x - 60; // 228
  const wireToolLoop = `M${toolLeft.x},${toolLeft.y} L${turnX},${toolLeft.y} L${llmTop.x + 24},${llmTop.y}`;

  // Calculate viewBox with padding
  const minX = 8;
  const maxX = 520;
  const minY = 8;
  const maxY = 220;

  return (
    <svg
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      width="100%"
      height="100%"
      role="img"
      aria-label="Noetic agent loop: prompt feeds into loop containing llm, tool, and run steps; loops back until break condition"
      style={{
        maxHeight: '280px',
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
          <polyline points="5,1 9,5 5,9" stroke={GREEN} strokeWidth="0.8" fill="none" />
        </marker>
        <marker
          id="prim-arrow-cyan"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="5,1 9,5 5,9" stroke={CYAN} strokeWidth="0.8" fill="none" />
        </marker>
        <marker
          id="prim-arrow-amber"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="5,1 9,5 5,9" stroke={AMBER} strokeWidth="0.8" fill="none" />
        </marker>
        <marker
          id="prim-arrow-muted"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="5"
          orient="auto"
        >
          <polyline points="5,1 9,5 5,9" stroke={MUTED} strokeWidth="0.8" fill="none" />
        </marker>
      </defs>

      {/* Loop boundary rectangle */}
      <rect
        x={loopLeft}
        y={loopTop}
        width={loopRight - loopLeft}
        height={loopBottom - loopTop}
        fill={CYAN}
        fillOpacity="0.02"
        stroke={CYAN}
        strokeWidth="0.8"
        strokeOpacity="0.35"
        strokeDasharray="6 4"
      />
      <text
        x={loopLeft + 12}
        y={loopTop + 14}
        textAnchor="start"
        fill={CYAN}
        fontSize="8"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
        letterSpacing="0.08em"
        opacity="0.6"
      >
        LOOP
      </text>

      {/* Wires - rendered before nodes */}
      {/* prompt → loop entry (muted) */}
      <path
        d={wirePromptLoop}
        fill="none"
        stroke={MUTED}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#prim-arrow-muted)"
      />

      {/* loop entry → llm (green - entering the loop) */}
      <path
        d={wireEntryLlm}
        fill="none"
        stroke={GREEN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#prim-arrow-green)"
      />

      {/* loop exit → until (green - exit) */}
      <path
        d={wireLoopExit}
        fill="none"
        stroke={GREEN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#prim-arrow-green)"
      />

      {/* llm → tool */}
      <path
        d={wireLlmTool}
        fill="none"
        stroke={AMBER}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#prim-arrow-amber)"
      />

      {/* llm → run */}
      <path
        d={wireLlmRun}
        fill="none"
        stroke={CYAN}
        strokeWidth="0.8"
        strokeOpacity="0.5"
        markerEnd="url(#prim-arrow-cyan)"
      />

      {/* tool → llm (loop back - dashed) */}
      <path
        d={wireToolLoop}
        fill="none"
        stroke={CYAN}
        strokeWidth="0.8"
        strokeOpacity="0.45"
        strokeDasharray="4 3"
        markerEnd="url(#prim-arrow-cyan)"
      />

      {/* Nodes */}
      <IsometricNode x={promptPos.x} y={promptPos.y} color={MUTED} label="prompt" muted />
      <IsometricNode x={llmPos.x} y={llmPos.y} color={GREEN} label="llm" />
      <IsometricNode x={toolPos.x} y={toolPos.y} color={AMBER} label="tool" />
      <IsometricNode x={runPos.x} y={runPos.y} color={CYAN} label="run" />

      {/* Until condition (break) - circle node outside loop */}
      <circle
        cx={untilPos.x + NODE_W / 2}
        cy={untilPos.y + NODE_H / 2}
        r={18}
        fill={SURFACE}
        stroke={GREEN}
        strokeWidth="0.8"
      />
      <circle
        cx={untilPos.x + NODE_W / 2}
        cy={untilPos.y + NODE_H / 2}
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
        x={untilPos.x + NODE_W / 2}
        y={untilPos.y + NODE_H / 2 - 2}
        textAnchor="middle"
        fill={GREEN}
        fontSize="12"
        fontFamily="JetBrains Mono, monospace"
        fontWeight="700"
      >
        ✓
      </text>
      <text
        x={untilPos.x + NODE_W / 2}
        y={untilPos.y + NODE_H / 2 + 10}
        textAnchor="middle"
        fill={GREEN}
        fontSize="7.5"
        fontFamily="JetBrains Mono, monospace"
        opacity="0.7"
      >
        until
      </text>

      {/* Animated glow spheres */}
      <GlowSphere
        color={MUTED}
        gradientId="prim-glow-green"
        path={wirePromptLoop}
        dur="3s"
        begin="0s"
      />
      <GlowSphere
        color={GREEN}
        gradientId="prim-glow-green"
        path={wireEntryLlm}
        dur="2.5s"
        begin="0.5s"
      />
      <GlowSphere
        color={GREEN}
        gradientId="prim-glow-green"
        path={wireLoopExit}
        dur="3s"
        begin="1.5s"
      />
      <GlowSphere
        color={AMBER}
        gradientId="prim-glow-amber"
        path={wireLlmTool}
        dur="3s"
        begin="0.3s"
      />
      <GlowSphere
        color={CYAN}
        gradientId="prim-glow-cyan"
        path={wireLlmRun}
        dur="3s"
        begin="0.6s"
      />
      <GlowSphere
        color={CYAN}
        gradientId="prim-glow-cyan"
        path={wireToolLoop}
        dur="4s"
        begin="0s"
      />
      <GlowSphere
        color={CYAN}
        gradientId="prim-glow-cyan"
        path={wireToolLoop}
        dur="4s"
        begin="2s"
      />
    </svg>
  );
}
