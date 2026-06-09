# Marketing Site

## Goals

- A clear, broad-audience value proposition is front and center within the hero — a static hook above the install line, plus a static 4-up pillar row below the CTA. No motion competes for attention in the first viewport.
- The page is organized around the **agent lifecycle** as four pillars — **Compose · Remember · Endure · Prove** — so the value prop and the feature sections tell one story.
- Copy is accessible to developers new to AI agents without condescending to experienced engineers.
- Every claim matches the shipped surface (e.g. the nine exported memory layers; the eval framework as a shipped capability, not "coming soon").
- Feature sections use the animated isometric SVG graphics (45° tube-map style, glowing sphere data flow) where a graphic adds clarity.
- A "Code Peek" tabbed section lets developers see the primitives in action.

---

## Value Proposition

The hero leads with a single broad-audience hook: a punchy subhead ("Build AI agents you'd actually trust in production.") + one supporting sentence, sized to read as the page's primary promise. Below the CTA buttons, a **static 4-up row** shows all four pillars at once — label-weight, scannable, no motion. Each column click-links to its pillar's anchor section below.

| # | Pillar | Headline | Support line |
|---|--------|----------|--------------|
| 01 | COMPOSE | It's just TypeScript. | Seven primitives you read, fork, and own. |
| 02 | REMEMBER | Context that doesn't blow up. | Nine memory layers keep token costs flat. |
| 03 | ENDURE | Survives production. | Checkpoint and resume — Node, browser, or sandbox. |
| 04 | PROVE | Prove it works. | Score and optimize like Jest tests. |

The row sits inside the hero with thin top + bottom dividers and intentionally stays label-weight so it doesn't visually compete with the CTA or the code window.

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

| # | Section | Pillar |
|---|---------|--------|
| 1 | Nav (with announcement banner) | — |
| 2 | Hero (with embedded value-props block) | — |
| 3 | Primitives | 01 · Compose |
| 4 | Patterns | 01 · Compose |
| 5 | Code Peek | 01 · Compose |
| 6 | Memory | 02 · Remember |
| 7 | Endurance | 03 · Endure |
| 8 | Eval | 04 · Prove |
| 9 | Differentiation | — |
| 10 | Footer | — |

Each pillar's cluster is preceded by a `PillarHeader` marker (`01 · COMPOSE`, etc.) and carries a stable anchor id (`compose`, `remember`, `endure`, `prove`) so the value-props block can scroll to it. Anchors use `scroll-margin-top` (≈110px) so they clear the fixed nav + banner.

---

## Section Specs

### 2. Hero

**Component:** `packages/web/components/landing/hero.tsx`

| Element | Content |
|---------|---------|
| Tag | `// constrain the agent, not the intelligence` |
| H1 | `NOETIC` |
| Subhead (hook) | "Build AI agents you'd actually trust in production." (clamp ~18–22px, weight 600) |
| Body | "Noetic gives you composable TypeScript primitives, memory that keeps token costs flat, and evals that catch regressions before users do." |
| Install | Static: `$ bun add @noetic-tools/core` with a muted `(npm · pnpm)` hint to the right — no cycling |
| CTA primary | "Build your first agent →" → `/docs` |
| CTA secondary | "GitHub ★" → GitHub URL |
| Value-props row | `<ValueProps />` — static 4-up pillar row, label-weight, with top/bottom dividers; see behavior below |
| Code block | TUI window with `react-agent.ts` snippet |

The hero is `position: sticky; height: 100vh` and fades out on scroll; the rest of the page scrolls over it in a `position: relative; z-index: 2` container.

**Value-props row** (`components/landing/value-props.tsx`):
- Static, centered (`max-width 960px`); shows all four pillars at once as a single 4-up row — no rotation, no auto-advance, no motion.
- Each column: pillar eyebrow in its pillar color (`01 · COMPOSE`), a one-line headline (label-weight, 14px), and a one-line support sentence. Click-links to the pillar's anchor (`#compose`, `#remember`, `#endure`, `#prove`).
- Thin top + bottom dividers (1px border) frame the row so it reads as a band, not a card grid.
- Intentionally label-weight (not headline-weight) so the row stays scannable and does not compete with the CTA or the code window.
- Responsive via `.value-props-grid`: 4 columns desktop → 2 columns at ≤768px → 1 column at ≤480px.
- Styling reuses existing TUI tokens; no new design tokens.

---

### 3. Primitives — *Compose*

**Component:** `packages/web/components/landing/primitives-viz.tsx`

| Element | Content |
|---------|---------|
| Tag | `core primitives` |
| H2 | "Meet the building blocks" |
| Subhead | "A small set of composable primitives. Build any agent pattern by combining the pieces you need." |
| Body | "Reasoning loops, parallel workloads, sub-agents — all of it falls out of these seven. The ReAct pattern is 15 lines. A task tree is 40. You can read both in under a minute." |
| Below | Legend (steps = green, operators = cyan) + bento grid of the seven primitives |

Seven primitives: `llm`, `tool`, `run` (steps); `spawn`, `fork`, `branch`, `loop` (operators). Each card links to its doc page.

**SVG:** `PrimitivesIsometricSvg` — three nodes (`llm` green, `tool` cyan, `loop` amber) on 45° wires with open arrows; `loop` has a dashed amber feedback wire back to `llm`, forming a visible cycle. Glowing spheres travel all paths.

---

### 4. Patterns — *Compose*

**Component:** `packages/web/components/landing/patterns-grid.tsx`

| Element | Content |
|---------|---------|
| Tag | `ready to use` |
| H2 | "Batteries included" |
| Subhead | "Common agent patterns built-in for convenience." |
| Body | "Each pattern is a composition of the primitives above — no special cases, no hidden behavior. Read the source. Fork it. The framework doesn't care." |
| Below | Pattern cards |

Patterns: ReAct (~15 lines), Ralph Wiggum (~10), Task Trees (~40), Adaptive Plans (~35), Thread Weaving (~25), Dual Agent (~20). Each card shows the primitives it composes and links to its doc page.

**SVG:** `PatternsIsometricSvg` — small primitive nodes converging into a larger "pattern" node, then flowing out as a result.

---

### 5. Code Peek — *Compose*

**Component:** `packages/web/components/landing/code-peek.tsx`

| Element | Content |
|---------|---------|
| Tag | `// read the source` |
| H2 | "Reasoning loop in 15 lines, full memory stack in 10. No boilerplate." |
| Body | "It's the same seven primitives from before. Once you know those, you can read — and change — anything." |

Tabs (TUI-style tab bar), each rendering a `<TuiWindow>` snippet:

| Tab label | Shows |
|-----------|-------|
| `ReAct reasoning loop` | ~15-line ReAct via `loop` / `llm` / `tool` + `until` |
| `5-layer memory in 10 lines` | `AgentHarness` configured with a stack of memory layers |
| `Sandboxed harness` | Swappable `FsAdapter` / `ShellAdapter` routing tools, skills, and memory |
| `Extend any primitive` | Custom `step.run` with typed context |

---

### 6. Memory — *Remember*

**Component:** `packages/web/components/landing/memory-system.tsx`

**Layout:** left (copy + layer grid) / right (isometric SVG).

| Element | Content |
|---------|---------|
| Tag | `// context management` |
| H2 | "Unparalleled memory management" |
| Subhead | "Long multi-turn conversations without blowing up the context window." |
| Body | "Working memory, observation extraction, plan tracking, durable checkpoints, and more — assemble the layers you need or build your own. Token costs stay predictable as conversations grow." |
| Below | Legend (working / retrieval / persistence) + grid of the nine layers and a custom-layer tile |

The grid shows the **nine exported memory layers** plus a "build your own" tile:

| Layer (label) | Export | Group |
|---------------|--------|-------|
| Working Memory | `workingMemory` | working |
| Observational Memory | `observationalMemory` | working |
| Steering | `steering` | working |
| Static Content | `staticContent` | working |
| History Window | `historyWindow` | retrieval |
| File Reference | `fileReference` | retrieval |
| Tool Memory | `toolMemoryLayer` | retrieval |
| Plan Memory | `planMemory` | persistence |
| Durable Task State | `durableTaskState` | persistence |
| Custom Layers | (build your own — e.g. semantic recall, episodic summaries) | — |

Group assignment + color follow the legend; final labels/grouping are confirmed against `docs/framework/memory/*`. "Semantic recall" and "episodic memory" are documented build-it-yourself recipes, not exported layers, so they appear only via the custom-layer tile/link (`docs/framework/memory/custom-layers`).

**SVG:** `MemoryIsometricSvg` — stacked isometric layer panels. Left wire: green sphere propagates **down** (writes & propagates). Right wire: cyan sphere travels **up** (`assembleView()` reads). Connector lines link each layer to both wires. LLM box at top-right receives assembled context. Callout: "raw history ≈ 6,000 tok → assembled context ≈ 680 tok".

---

### 7. Endurance — *Endure*

**Component:** `packages/web/components/landing/endurance.tsx`

| Element | Content |
|---------|---------|
| Tag | `// production-grade` |
| H2 | "Built to survive production" |
| Subhead | "The parts that matter once an agent leaves your laptop." |
| Below | Bento grid of three cards |

| Card | Value | Link |
|------|-------|------|
| Durable execution | Checkpoint and resume; long runs survive crashes. | `/docs/framework/durability` |
| Runs anywhere | Node, the browser, or a sandbox — swap `fs` / `shell` / `llm` adapters; Mirage virtual filesystem. | — (no dedicated doc page yet) |
| JSON workflow runtime | Define and run an agent declaratively from JSON. | `/docs/framework/json-runtime` |

Cards reuse the existing bento/card styles (`tui-bento`, surface backgrounds, `TuiBadge`, `HOVER_BG`). No code window — Code Peek carries the examples.

---

### 8. Eval — *Prove*

**Component:** `packages/web/components/landing/eval-framework.tsx` (`EvalFramework`)

| Element | Content |
|---------|---------|
| Tag | `what's next` → reframe to a shipped-capability tag |
| H2 | "Eval Framework" |
| Subhead | "Write evals as easily as Jest tests." |
| Body | "Define what 'good' looks like for your agent, run it against a dataset, and let the optimizer improve it. Same primitives. Same runtime. Just a feedback loop added." |

Shows a `<TuiWindow>` eval-run mockup. No "Coming Soon" badge and no RL-pipeline lines — the eval framework (`describe` / `it` / `scorer` / `optimize`, GEPA optimization, regression gating with a CLI exit code) is shipped; there is no RL pipeline.

---

### 9. Differentiation

**Component:** `packages/web/components/landing/differentiation.tsx`

**Section tag:** `// the landscape`
**H2:** "What makes Noetic different?"

Comparison strip (bordered rows), Noetic row highlighted (green accent):

| Framework | Pain point |
|-----------|-----------|
| LangChain | "Magic on the way in. Black box on the way out." |
| LangGraph | "Powerful. Also: now you're a graph theorist." |
| CrewAI | "Works great until it doesn't." |
| AI SDK | "Too magical a primitive to build anything with confidence." |
| **Noetic** | "**Seven primitives. Read it, extend it, ship it — it's just TypeScript.**" |

**Callout below the table:** "OpenAI, Anthropic, local models, or a custom adapter. Bring your own provider."

---

## Components

| Component | File | Description |
|-----------|------|-------------|
| `ValueProps` | `components/landing/value-props.tsx` | Static 4-up pillar row (no rotation), rendered inside the hero below the CTA |
| `PillarHeader` | `components/landing/pillar-header.tsx` | Pillar marker (`01 · COMPOSE`) + anchor id for each cluster |
| `Endurance` | `components/landing/endurance.tsx` | Bento of durable execution / runs-anywhere / JSON runtime |
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
  <Hero />                              {/* embeds <ValueProps /> below the CTA */}
  <div className="post-hero">           {/* position: relative; z-index: 2; tui-bg */}
    <PillarHeader id="compose" index="01" name="Compose" />
    <PrimitivesViz />
    <PatternsGrid />
    <CodePeek />

    <PillarHeader id="remember" index="02" name="Remember" />
    <MemorySystem />

    <PillarHeader id="endure" index="03" name="Endure" />
    <Endurance />

    <PillarHeader id="prove" index="04" name="Prove" />
    <EvalFramework />

    <Differentiation />
  </div>
</main>
<Footer />
```

`PillarHeader` carries the anchor `id` directly (with `scroll-margin-top`), so cluster contents render as siblings rather than inside an outer `<section>` wrapper.

### CSS (`global.css`)
- Pillar anchor sections set `scroll-margin-top` (≈110px) to clear the fixed nav + announcement banner.
- `.section-split` — two-column layout within Memory (copy left, SVG right).
- Carousel uses `motion`/`AnimatePresence` crossfade; reduced-motion handled in component via `useReducedMotion`.
- SVG animation keyframes where needed (most animations use SVG SMIL `animateMotion`).

---

## SVG Design System

All marketing site SVGs must follow these specifications exactly.

### Node Geometry

```tsx
const NODE_W = 72;   // Width
const NODE_H = 36;   // Height
const NODE_D = 10;   // Isometric depth (extends beyond front face)
```

**Structure:**
- **Top face**: polygon extending `NODE_D` pixels back and up
- **Front face**: rectangle (main visible surface)
- **Right face**: polygon extending `NODE_D` pixels back
- **Pulse animation**: `fill-opacity` 0 → 0.06 → 0, 3s duration

### Color Palette

| Variable | Hex | Usage |
|----------|-----|-------|
| `GREEN` | `#39ff14` | LLM nodes, primary flow, success states |
| `CYAN` | `#38bdf8` | Tool nodes, read operations, actions |
| `AMBER` | `#ffb000` | Memory/observation, loops, feedback |
| `MUTED` | `#475569` | External inputs, boundaries |
| `SURFACE` | `#080808` | Node fill color |
| `BORDER_COLOR` | `#1a1a1a` | Memory layer borders |

### Typography

- **Font**: JetBrains Mono, monospace
- **Weights**: 700 (labels), 400 (descriptions)
- **Sizes**: 11px (nodes), 9px (headers), 8px (descriptions)
- **Letter spacing**: 0.06em

### Connection Lines

- **Stroke width**: 0.8px
- **Stroke opacity**: 0.5 (standard), 0.45 (dashed loops)
- **Dash pattern**: `"4 3"` for feedback/loop lines
- **Angles**: 45° segments (horizontal + diagonal), 90° when necessary
- **Segment minimum**: 28px per segment

**Wire Termination:**
- Terminate at node edges, not through nodes
- For arrow visibility: terminate 12px before edge, or render wire **after** node in SVG document order (higher z-index)

### Arrow Head Specifications

**Marker Definition:**
```tsx
<marker
  id="[prefix]-arrow-[color]"
  markerWidth="10"
  markerHeight="10"
  refX="9"
  refY="5"
  orient="auto"
>
  <polyline 
    points="5,1 9,5 5,9"  // 45° angle chevron
    stroke={COLOR}         // Must match line color exactly
    strokeWidth="0.8"      // Matches line width
    fill="none"
  />
</marker>
```

**Critical Requirements:**
1. **45° angles**: Use `points="5,1 9,5 5,9"` (not `"1,1 9,5 1,9"`)
2. **Color match**: Arrow stroke must exactly match connection line stroke
3. **Width match**: 0.8px to match connection lines
4. **No fill**: `fill="none"`

### Animation

**Glow Spheres:**
```tsx
<circle r="8" fill={`url(#${gradientId})`} />
<circle r="2.5" fill={color} />
<animateMotion
  path={wirePath}
  dur="2.5s"
  begin="0s"  // Stagger: 0s, 0.3s, 0.6s, 0.9s...
  repeatCount="indefinite"
  calcMode="linear"
/>
```

**Gradients:**
```tsx
<radialGradient id="glow-green" cx="50%" cy="50%" r="50%">
  <stop offset="0%" stopColor={GREEN} stopOpacity="0.8" />
  <stop offset="100%" stopColor={GREEN} stopOpacity="0" />
</radialGradient>
```

**Blur Filter:**
```tsx
<filter id="blur" x="-50%" y="-50%" width="200%" height="200%">
  <feGaussianBlur stdDeviation="2.5" />
</filter>
```

### Grouping/Container Boxes

When showing grouped concepts (e.g., "ReAct pattern"):

- **Padding**: 10px minimum on all sides
- **Stroke**: Dashed `"6 4"` pattern
- **Stroke width**: 1px
- **Stroke opacity**: 0.4
- **Fill**: Color with 0.02 opacity
- **Label**: Positioned at top-left with 12px inset

**Account for depth**: The isometric right face extends `NODE_D` (10px) beyond the front face, so right padding must include this extension.

### ViewBox Guidelines

- **Minimum padding**: 16px around all elements
- **Consistent sizing**: Use `maxHeight` in CSS (e.g., `maxHeight: '232px'`)
- **Calculate coordinates**: Use absolute positioning with documented calculations

### Implementation Checklist

Before committing a new SVG:

- [ ] All connection segments ≥ 28px
- [ ] All angles are 45° (or 90° where necessary)
- [ ] Arrow heads use 45° points: `points="5,1 9,5 5,9"`
- [ ] Arrow stroke width is 0.8px (matches lines)
- [ ] Arrow colors match line colors exactly
- [ ] Wires with visible arrows render **after** nodes in document order
- [ ] Node depth (10px) accounted for in container padding
- [ ] Typography follows JetBrains Mono stack
- [ ] Glow spheres with staggered animation timing
- [ ] Pulse animation on all interactive nodes
- [ ] 10px minimum padding in container boxes
- [ ] No text overlapping nodes (36px reserved for labels)
- [ ] `role="img"` and `aria-label` for accessibility
- [ ] `prefers-reduced-motion` CSS support

---

## Future Considerations

- **Code CLI launch.** The Noetic Code CLI is intentionally pre-launch ("Coming Soon" in the nav banner and on `/code`). When it ships, the banner, the `/code` page, and a possible Endure/Prove cross-link are revisited.
- **Runs-anywhere documentation.** The "Runs anywhere" card links nowhere until a platform-packages / virtual-filesystem doc page exists; add the link when that page lands.
- **Browser demo.** A live in-browser agent demo would substantiate the "runs in the browser" claim beyond adapter support.
