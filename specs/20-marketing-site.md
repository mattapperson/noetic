# Marketing Site

## Goals

- Copy is accessible to developers new to AI agents without condescending to experienced engineers
- Noetic's three differentiators are unmistakably clear: composable primitives, pre-built patterns, reactive memory
- Each value-prop section includes an animated isometric SVG graphic (45° tube-map style, glowing sphere data flow)
- A "Code Peek" tabbed section lets developers see the primitives in action

---

## Visual Language

All SVG graphics follow this style:

- **Projection:** 45° isometric (tube-map style — all line segments at 0°, 45°, or 90° only)
- **Nodes:** 3-face isometric panels — top face, front face, right face; colored border per node type
- **Wires:** thin (0.8px stroke), dark-tinted color; open chevron arrowheads (`>` shape, no fill)
- **Data flow:** glowing spheres — small solid core (r=2.5) with large radial-gradient glow (r=9, blurred); multiple staggered spheres per wire
- **Colors:** green `#00ff80` (llm/primary), cyan `#00d4ff` (tool/read), amber `#ffaa00` (loop/durable)
- **Background:** matches `var(--color-tui-bg)` (#0d0d0d); node faces use very dark tinted fills

---

## Page Structure

| # | Section |
|---|---------|
| 1 | Nav |
| 2 | Hero |
| 3 | Differentiation block |
| 4 | Primitives |
| 5 | Patterns |
| 6 | Memory |
| 7 | Code Peek |
| 8 | Coming Soon + Footer |

Sections 4 (Primitives) and 5 (Patterns) render **side-by-side** on desktop.

---

## Section Specs

### 2. Hero

**Component:** `packages/web/components/landing/hero.tsx`

| Element | Content |
|---------|---------|
| Tag | `// not another graph-based framework` |
| H1 | `NOETIC` |
| Subhead | "Build complex AI agents without the framework tax." |
| Body | "Proven patterns for ReAct, task trees, and dual-agent loops — or compose from seven primitives directly. Reactive memory decides what to keep, compress, and retrieve so your agents stay coherent across long conversations without bloating the context window." |
| Install | `$ bun add @noetic/core` (cycling, prominent near CTAs) |
| CTA primary | "Start building (5 min quickstart)" → `/docs` |
| CTA secondary | "View on GitHub ★" → GitHub URL |
| Code block | TUI window with `react-agent.ts` snippet |

---

### 3. Differentiation Block

**Component:** `packages/web/components/landing/differentiation.tsx`

**Section tag:** `// why noetic`
**H2:** "Built differently than the frameworks you've tried"

Four-row comparison strip (TUI-style table or bordered rows):

| Framework | Pain point |
|-----------|-----------|
| LangChain | "Too much magic. Debugging is a nightmare." |
| LangGraph | "Powerful, but now you're thinking in graphs." |
| CrewAI | "Fine until you need to customize anything." |
| **Noetic** | "**Seven primitives. Composable. You read the code.**" |

The Noetic row is visually highlighted (green border/accent).

**Callout below the table:**
"Works with any model provider — OpenAI, Anthropic, local models, or your own adapter."

---

### 4. Primitives

**Component:** `packages/web/components/landing/primitives-viz.tsx`

**Layout:** stacked — heading + copy at top, SVG below, bento grid at bottom. When side-by-side with Patterns, each section occupies one column.

| Element | Content |
|---------|---------|
| Tag | `// primitives` |
| H2 | `` llm · tool · run · branch · fork · spawn · loop `` (monospace, displayed as code) |
| Subhead | "The smallest units of agent behavior. Each does one thing. Compose them to build any workflow." |
| Body | "Noetic gives you seven composable steps — the foundation of every agent pattern. Combine them into reasoning loops, parallel branches, tool calls, sub-agents. No generated code, no hidden orchestration." |
| Below | Bento grid of primitive cards |

**SVG:** `PrimitivesIsometricSvg`
Three nodes (`llm` green, `tool` cyan, `loop` amber) connected by 45° wires with open arrows. The `loop` node has a dashed amber feedback wire returning to `llm`, forming a visible cycle. Glowing spheres travel all wire paths.

---

### 5. Patterns

**Component:** `packages/web/components/landing/patterns-grid.tsx`

**Layout:** stacked — heading + copy at top, SVG below, pattern cards at bottom. Renders side-by-side with Primitives on desktop; each occupies one column.

| Element | Content |
|---------|---------|
| Tag | `// batteries included` |
| H2 | "ReAct. Task trees. Dual-agent loops. Adaptive plans." |
| Subhead | "Production patterns, built from primitives you already understand." |
| Body | "The workflows that actually work in production — each one a composition of Noetic primitives. No generated abstractions, no locked-in behavior. Read the source, fork it, make it yours." |
| Below | Pattern cards |

**SVG:** `PatternsIsometricSvg`
Multiple small primitive nodes (mini-cubes) with wires converging into a larger "pattern" node, then flowing out as a result. Represents the composition story visually.

---

### 6. Memory

**Component:** `packages/web/components/landing/memory-system.tsx`

**Layout:** left (copy + layer list) / right (isometric SVG)

| Element | Content |
|---------|---------|
| Tag | `// memory` |
| H2 | "Five memory layers. One reactive context window." |
| Subhead | "Working memory, semantic recall, episodic state, and more — each optimized for a different kind of information." |
| Body | "Noetic decides what to keep in context, what to compress, and what to retrieve from long-term storage. When one layer updates, dependent layers react automatically. Your agents stay coherent across long conversations. Your token bill doesn't blow up." |
| Below | Memory layer list |

**SVG:** `MemoryIsometricSvg`
Five stacked isometric layer panels. Left wire: green sphere propagates **down** (writes & propagates). Right wire: cyan sphere travels **up** (assembleView() reads). Connector lines link each layer to both wires. LLM box at top-right receives assembled context. Callout: "raw history ≈ 6,000 tok → assembled context ≈ 680 tok".

---

### 7. Code Peek

**Component:** `packages/web/components/landing/code-peek.tsx`

| Element | Content |
|---------|---------|
| Tag | `// under the hood` |
| H2 | "Every pattern is just primitives. Read it. Test it. Own it." |
| Body | "No generated abstractions. No framework internals to debug. The ReAct loop below is the same primitives you saw above — just composed." |

Three tabs (TUI-style tab bar):

| Tab label | Shows |
|-----------|-------|
| `ReAct reasoning loop` | ~15-line ReAct implementation using `loop`, `llm`, `tool` |
| `5-layer memory in 10 lines` | Memory system setup with `InMemoryRuntime` and layer config |
| `Extend any primitive` | Custom step extending `run` with typed context |

Each tab renders a `<TuiWindow>` with the code snippet.

---

## Components

| Component | File | Description |
|-----------|------|-------------|
| `Differentiation` | `components/landing/differentiation.tsx` | Competitor comparison strip + model-agnostic callout |
| `CodePeek` | `components/landing/code-peek.tsx` | Tabbed code examples |
| `PrimitivesIsometricSvg` | `components/landing/svgs/primitives-isometric.tsx` | Animated SVG for Primitives section |
| `PatternsIsometricSvg` | `components/landing/svgs/patterns-isometric.tsx` | Animated SVG for Patterns section |
| `MemoryIsometricSvg` | `components/landing/svgs/memory-isometric.tsx` | Animated SVG for Memory section |

---

## Layout

### `page.tsx`
```tsx
<Nav />
<main>
  <Hero />
  <Differentiation />
  <div className="side-by-side-sections">
    <PrimitivesViz />
    <PatternsGrid />
  </div>
  <MemorySystem />
  <CodePeek />
  <ComingSoon />
</main>
<Footer />
```

### CSS (`global.css`)
- `.side-by-side-sections` — flexbox row on desktop, column on mobile, equal widths, shared gap
- `.section-split` — two-column layout within Memory section (copy left, SVG right)
- SVG animation keyframes where needed (most animations use SVG SMIL `animateMotion`)

---

## SVG Technical Spec

### Geometry
- All angles: 0°, 45°, or 90° only (no other angles)
- Node depth: 14px (front→top face diagonal)
- Wire stroke: `0.8px`
- Arrow marker: open chevron `>`, `stroke-width: 1.5`, no fill

### Animation
- Sphere travel: SVG `<animateMotion>` with `path` attribute and `calcMode="linear"`
- Multiple spheres per wire with staggered `begin` offsets (typically `dur/2`)
- Glow: `<radialGradient>` + `<feGaussianBlur stdDeviation="2.5">` filter on large circle
- No JavaScript required for SVG animations

### Accessibility
- All SVGs include `role="img"` and `aria-label` describing what they show
- Animations respect `prefers-reduced-motion` via CSS: `@media (prefers-reduced-motion: reduce) { svg * { animation-play-state: paused; } }`
