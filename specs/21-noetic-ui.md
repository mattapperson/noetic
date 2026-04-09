# Noetic UI Spec

> **Depends On:** `08-runtime` (AgentHarness), `10-observability` (TraceExporter, Span), `07-context-and-event-log` (Context, Item, ItemLog), `01-step-type` (Step, StepKind)
> **Exports:** (none — developer tool only, no public API exports)

---

## Package

`@noetic/ui` — Optional developer tool package for visual debugging.

Published from `packages/ui/` as a separate optional install: `npm install -D @noetic/ui`

---

## Overview

Noetic UI is an independent, optional developer tool package that provides a visual interface for debugging Noetic agent workflows. It serves as a comprehensive execution recorder and playback debugger when enabled in development environments.

**Key Capabilities:**
- **Agent Browser** - Discover and browse agents from your codebase, organized by file path
- **Execution Recording** - Automatically records every agent run with full trace data (debug mode only)
- **Playback Debugging** - Scrub through recorded execution history to see what happened at any point
- **Visual Execution Flow** - Interactive node graph showing step-by-step execution
- **Data Inspection** - Inspect input, output, and state at any point in time

**Zero Production Impact:**
- UI instrumentation is **completely disabled** by default
- No performance overhead in production environments
- No additional dependencies loaded unless explicitly enabled
- All debug hooks are tree-shaken from production builds

**Workflow:**
1. Enable debug mode with `NOETIC_UI_ENABLED=true`
2. Browse agents in the left sidebar (organized by file path)
3. Select an agent to see its execution history (runs)
4. Select a run to view its execution trace in the center canvas
5. Use the playback controls to scrub through execution time
6. Click any step to inspect its data in the right panel

In debug mode, all executions are recorded automatically, enabling retroactive debugging and analysis. In production, the core API runs at full speed with zero instrumentation overhead.

---

## Core Concepts

### Visual Design Philosophy

Noetic UI design principles:

- **System theme** as default (auto-switches between light/dark based on OS preference)
- **Card-based nodes** with subtle borders and status-colored accents
- **Grid-snapped vertical layout** for execution flow (nodes snapped to a virtual grid, arranged top-to-bottom with parallel paths side-by-side)
- **Three-panel layout:** left navigation, center canvas, right inspector
- **Playback timeline** at bottom with transport controls
- **Status icons** prominently displayed on each node (✓ ▶ ⏸ ✗ ○ ⊘)

### 1. Execution Visualization

The UI renders execution as a **grid-snapped flow diagram** with orthogonal edge routing and recursive nesting:

- **Grid System:** All node positions snap to a virtual grid (20px cells). This ensures consistent alignment between nodes and edge routing regardless of which routing strategy produces the path.

- **Sequential Layout:** Nodes arranged vertically top-to-bottom in execution order
  - Each step gets its own node card
  - Flow moves downward from start to completion
  - Clear visual hierarchy showing execution sequence

- **Parallel Layout:** Fork and branch children are positioned **horizontally** side-by-side
  - Fork paths show parallel execution lanes
  - Branch paths show alternative conditional routes; the selected/active path renders at full opacity while unselected paths are slightly dimmed
  - Sibling nodes never overlap (collision detection pushes apart horizontally for parallel, vertically for sequential)

- **Nested Container Scaling:**
  - Container nodes (loop, fork, branch, spawn) render as bounding boxes enclosing their children
  - The root container is invisible — its children (top-level steps) render at **100%** size
  - Below the root, children scale to **50%** of parent size at each nesting level (50% → 25% → 12.5%)
  - Container padding scales proportionally with the scale factor
  - Clicking a container node triggers an animated zoom transition centering the container so children appear at 100% base size
  - A breadcrumb trail tracks zoom depth; clicking background or back button animates to the previous zoom level
  - Nested zoom stacks (click into a loop, then into a fork inside it)

- **Loop Visualization:**
  - Loop nodes serve as **container nodes** with visual grouping
  - Steps inside loops are scaled and contained within the loop bounding box
  - Loop-back edges route orthogonally around child nodes from last child back to first child

- **Node Cards** display:
  - Step kind badge with icon (LLM 💬, TOOL 🔧, FORK ⫚, etc.)
  - Step title and ID
  - Status icon with color coding (✓ completed, ▶ running, ✗ error, etc.)
  - Duration and execution metrics
  - Connection edges flowing to next step

- **Edges:**
  - **Orthogonal routing:** All edges travel in horizontal/vertical segments only (90° increments) with a consistent corner radius at turns
  - **Connection points:** Edges connect from/to the center point of the top, right, bottom, or left edge of a node. The side with the largest edge-to-edge gap toward the target is preferred. For container→child edges (where one node contains another), vertical anchors aligned to the child's center-x produce clean straight-down connections.
  - **Obstacle avoidance:** Edges route around nodes, never through them. Simple routes use Z-shaped or L-shaped paths; when these would cross a node, A* pathfinding finds an obstacle-free route.
  - **Edge spacing:** Parallel edges are offset by several grid cells so they remain easy to follow
  - **Thin lines:** 1.5px stroke width with unfilled arrowheads at the terminus

- **Edge Visual Language** (color encodes the structural pattern, not the node status):

  | Type | Style | Color | Use Case |
  |------|-------|-------|----------|
  | `default` | Solid line | Source node status color | Normal sequential flow |
  | `conditional` | Dashed line | Yellow (#eab308, branch kind) | Branch condition paths |
  | `fork` | Solid line | Pink (#ec4899, fork kind) | Parallel execution paths |
  | `loop` | Dotted line | Teal (#14b8a6, loop kind) | Loop-back iterations |
  | `spawn` | Dash-dot line | Indigo (#6366f1, spawn kind) | Spawn child connections |

- **Color coding by status:**
  - **Green** (#10b981) - completed/success
  - **Blue** (#3b82f6) - active/running/focus
  - **Yellow/Orange** (#f59e0b) - warning/paused
  - **Red** (#ef4444) - error
  - **Gray** (#6b7280) - pending/not visited

### 2. Data Inspection

Each node can be selected to show details in the right panel:

- **Tabs:** session | attempt | events
- **Content areas:**
  - **System prompts** (for LLM steps)
  - **Input/output data** with syntax highlighting
  - **Context state** (memory, tokens, cost, depth)
  - **Step metadata** (execution time, retry count, LLM usage)
  - **Item log** (conversation history for LLM steps)
  - **Raw traces** (OpenTelemetry span data)
- **Text display** with monospace fonts for code/JSON
- **Follow/Overview toggle** for different detail levels

### 3. Debugging Controls

Playback controls at bottom (like a media player):
- **Transport buttons:** ⏮ (restart), ⏴ (step back), ⏯ (play/pause), ⏵ (step forward), ⏭ (end)
- **Playback speed:** 1x, 2x, 5x, 10x toggle buttons
- **Timeline scrubber** showing execution progress
- **Current position** display (e.g., "Step 9 / 24")

Debug actions:
- **Pause/Resume** - halt execution at current step
- **Step Over** - execute current step, pause at next sibling
- **Step Into** - if step has children (spawn/loop/fork), pause at first child
- **Step Out** - run until current context completes, pause at parent
- **Breakpoints** - pause when specific steps or conditions are hit
- **Restart** - re-run from beginning with same or modified input

### 4. Recording, Event Log & Traces

**Recording Architecture:**
- **Automatic recording** - Every execution is captured in full
- **Runs are first-class** - Each execution creates a run entry
- **Persistent storage** - Runs stored locally with configurable retention
- **Real-time streaming** - Live runs stream to UI as they execute
- **Retroactive inspection** - Access any historical run from the agent browser

**Time-Travel Debugging (Observational Only):**
- **Scrub through history** - Navigate to any point in any recorded run to see what happened
- **View historical state** - See execution state at any moment (stored snapshots only)
- **Comparison mode** - Compare two runs or two points within a run
- **Export at any point** - Export trace data from any execution state

**Note:** Time-travel is purely observational like watching a video recording. It displays stored snapshots without re-executing any code.

**Event Log Features:**
- **Real-time event stream** - all step start/completion events
- **Chronological view** - Scroll through execution timeline
- **Searchable/filterable** by step kind, status, time range, step ID
- **Full trace export** - OpenTelemetry-compatible span export
- **Diff view** - compare two execution runs side-by-side
- **Bookmark important steps** - Mark steps for quick navigation

---

## Architecture

### Package Structure

```
packages/ui/
├── app/                    # Next.js app directory (built UI)
│   ├── layout.tsx
│   ├── page.tsx
│   └── globals.css
  ├── src/
  │   ├── service/           # Server-side code (WebSocket + API)
  │   │   ├── index.ts      # Server entry point
  │   │   ├── websocket.ts  # WebSocket message protocol
  │   │   ├── storage.ts    # Execution trace persistence
  │   │   └── api.ts        # REST API for queries
  │   ├── client/           # Web UI (React + Next.js)
  │   │   ├── components/   # Node graph, inspectors, controls
  │   │   ├── stores/       # Zustand state management
  │   │   ├── hooks/        # React hooks (WebSocket, execution)
  │   │   └── lib/          # Client utilities
  │   ├── runtime/          # Runtime integration
  │   │   ├── exporter.ts   # TraceExporter implementation
  │   │   ├── debugger.ts   # Debug runtime with pause/resume
  │   │   ├── hook.ts       # Execution hooks for capturing events
  │   │   └── step-extractors.ts  # Step data extraction plugins
  │   └── shared/           # Shared types & protocol
  │       ├── protocol.ts   # WebSocket message types
  │       └── types.ts      # Common interfaces
├── bin/
│   └── noetic-ui.js      # CLI entry point (runtime detection)
├── scripts/
│   ├── build-executables.js  # Cross-platform build automation
│   └── install.sh           # User install script
├── .github/workflows/
│   └── build-executables.yml  # CI/CD for releases
├── package.json
└── README.md
```

**Distribution Artifacts:**

```
dist-exe/                           # Built executables (not in repo)
├── noetic-ui-darwin-arm64         # macOS Apple Silicon
├── noetic-ui-darwin-x64           # macOS Intel
├── noetic-ui-linux-arm64          # Linux ARM64
├── noetic-ui-linux-x64            # Linux x64
└── noetic-ui-win32-x64.exe        # Windows x64
```

### Integration Points

Noetic UI integrates with the core framework through three mechanisms:

#### 1. TraceExporter (Read-only Observation)

```typescript
import { setTraceExporter } from '@noetic/core';
import { NoeticUITraceExporter } from '@noetic/ui/runtime';

// In your app entry point when dev mode is enabled
if (process.env.NOETIC_UI_ENABLED) {
  const uiExporter = new NoeticUITraceExporter({
    port: 3333,  // WebSocket port for UI server
  });
  setTraceExporter(uiExporter);
}
```

The exporter receives span data and forwards it to the UI server via WebSocket.

#### 2. Debug Runtime (Full Control)

```typescript
import { AgentHarness } from '@noetic/core';
import { createDebugHarness } from '@noetic/ui/runtime';

// Replace AgentHarness with DebugAgentHarness for full debugging
const harness = createDebugHarness({
  name: 'my-agent',
  initialStep: myStep,
  // ... other config
  debugger: {
    breakpoints: ['step-3', 'verify-loop'],
    pauseOnError: true,
    autoStart: false,  // Wait for UI to initiate
  }
});
```

The debug harness wraps execution and allows external control.

#### 3. Step Data Extractor Plugins (Extensible Data Transformation)

The exporter uses a **plugin-based architecture** for transforming span attributes into step-specific data for UI rendering. This allows new step kinds to be added without modifying the exporter.

**Plugin Registration:**

```typescript
import { registerStepDataExtractor } from '@noetic/ui/runtime';

// Register a custom step extractor
registerStepDataExtractor('myStep', (spanAttrs, tokenUsage, cost) => {
  return {
    customField: spanAttrs.customField,
    tokenUsage,
    cost,
  };
});
```

**Built-in Extractors:**

The following step kinds have built-in extractors registered by default:

| Step Kind | Data Fields |
|-----------|-------------|
| `llm` | model, messages, toolCalls, systemPrompt, tokenUsage, cost |
| `tool` | toolName, arguments, result |
| `fork` | mode, pathCount, winnerPath |
| `loop` | stepCount, currentIteration, maxIterations |
| `spawn` | childId, childKind |
| `branch` | branchType, selectedPath, condition |
| `run` | description |
| `provide` | providerId, provides |

**Plugin API:**

```typescript
// Check if extractor exists
hasStepDataExtractor('llm'); // true

// Get extractor for a step kind
const extractor = getStepDataExtractor('llm');
const data = extractor(spanAttrs, tokenUsage, cost);

// List all registered kinds
const kinds = getRegisteredStepKinds(); 
// ['llm', 'tool', 'fork', 'loop', 'spawn', 'branch', 'run', 'provide']

// Unregister (mainly for testing)
unregisterStepDataExtractor('myStep');

// Clear all extractors (testing only)
clearStepDataExtractors();
```

**How it Works:**

1. The exporter receives span data from the core
2. It looks up the extractor for the step's `kind` attribute
3. Falls back to generic extractor if none registered
4. Calls the extractor with span attributes, token usage, and cost
5. Result becomes the `stepData` field in the ExecutionNode
6. UI components render based on stepData contents

**Benefits:**

- **Open/Closed Principle:** New step kinds added without core changes
- **Single Responsibility:** Each step type owns its data transformation
- **Testability:** Extractors can be tested in isolation
- **Extensibility:** Users can add custom extractors for domain-specific steps

### Debug Mode vs Production Mode

Noetic UI operates in two distinct modes to ensure zero production impact:

#### Debug Mode (Development)

When `NOETIC_UI_ENABLED=true` or calling `createDebugHarness()`:

- **Enhanced Data Collection:**
  - Full execution traces with step-by-step data
  - Input/output snapshots at every step
  - Memory layer state changes
  - Context snapshots (tokens, cost, depth)
  - Item log entries (full conversation history)
  - Breakpoint hit history
  - Pause/resume event log

- **Real-time Streaming:**
  - WebSocket connection to UI server
  - Live execution updates
  - Pause/resume control from UI
  - Breakpoint evaluation

- **Performance Impact:** Acceptable overhead in development (10-20% slower due to full recording)
- **Memory Monitoring:** Real-time memory usage indicator with color-coded warnings

**Memory Warning System:**
- **Visual indicators** during execution:
  - 🟢 **Green:** < 50 MB - Healthy
  - 🟡 **Yellow:** 50-200 MB - Monitor closely
  - 🟠 **Orange:** 200-500 MB - Consider stopping for large traces
  - 🔴 **Red:** > 500 MB - Very large trace, user discretion
- **No automatic limits** - users decide when to stop based on warnings
- **Memory displayed** in run list and during live execution
- **Tooltip** on memory indicator shows breakdown (input data, output data, snapshots)

#### Production Mode (Default)

When Noetic UI is **not** enabled (default behavior):

- **Zero Runtime Overhead:**
  - No trace collection
  - No WebSocket connections
  - No additional memory allocation
  - No breakpoint checks
  - No state snapshots

- **Standard Execution:**
  - Core API runs at full speed
  - No instrumentation hooks active
  - Results and errors returned normally
  - No external dependencies loaded

#### Implementation Strategy

**Tree-shaking Compatible:**
```typescript
// Debug imports only loaded when needed
if (process.env.NOETIC_UI_ENABLED) {
  const { createDebugHarness } = await import('@noetic/ui/runtime');
  const { NoeticUITraceExporter } = await import('@noetic/ui/runtime');
  
  // Setup debugging
  const harness = createDebugHarness(config);
  setTraceExporter(new NoeticUITraceExporter());
}
```

**Conditional Hook Registration:**
```typescript
// In core runtime - hooks check for debugger presence
export function execute(step, input, ctx) {
  // Standard execution path (always runs)
  
  // Debug path only executes if debugger attached
  if (ctx.harness.debugger?.isAttached) {
    ctx.harness.debugger.onStepStart(step, input, ctx);
  }
  
  const result = executeStep(step, input, ctx);
  
  // Debug path only executes if debugger attached
  if (ctx.harness.debugger?.isAttached) {
    ctx.harness.debugger.onStepComplete(step, result, ctx);
  }
  
  return result;
}
```

**Performance Guarantees:**
- No UI-related code in production bundles (tree-shaken)
- No additional memory allocation when disabled
- Hook checks are simple boolean flags (nanosecond cost)
- WebSocket and storage layers not loaded unless explicitly enabled
- Breakpoint engine completely bypassed in production

### CLI Integration

**Distribution Strategy: Standalone Executables**

Noetic UI is distributed as **standalone executables** to provide zero-dependency installation across all platforms. This approach was chosen to eliminate runtime compatibility issues and provide the best user experience.

**Installation Methods (in order of preference):**

1. **Standalone Executable (Recommended)**
   ```bash
   # macOS/Linux - One-line install
   curl -fsSL https://raw.githubusercontent.com/mattapperson/noetic/main/packages/ui/scripts/install.sh | bash
   
   # Or download manually from GitHub releases
   # https://github.com/mattapperson/noetic/releases
   ```
   
   **Benefits:**
   - Zero dependencies (includes embedded runtime)
   - Single binary (~50-110MB depending on platform)
   - Works immediately after download
   - No package manager required
   - Consistent behavior across all systems

2. **Docker**
   ```bash
   docker run -p 3333:3333 -p 3334:3334 noetic/ui
   ```
   
   **Benefits:**
   - Containerized, isolated environment
   - Perfect for CI/CD pipelines
   - No local installation needed

3. **Bun/NPX (Development Only)**
   ```bash
   # Requires Bun: https://bun.sh
   bunx @noetic/ui serve
   ```
   
   **Benefits:**
   - Access to programmatic API
   - Development and debugging
   - Integration with existing Bun projects
   
   **Limitations:**
   - Requires Bun runtime
   - TypeScript source execution
   - Not recommended for end users

**Why Not Universal Package Manager Support?**

We evaluated supporting npm/yarn/pnpm universally but decided against it because:

1. **Runtime Dependency Hell:** Supporting Node.js + Bun + Deno creates a 2x testing burden
2. **Bun-Specific APIs:** The server uses Bun's native APIs for optimal performance
3. **Compilation Complexity:** Transpiling TS→JS for Node introduces maintenance overhead
4. **Size Trade-off:** Pre-compiled binaries (50-110MB) are actually smaller than node_modules (150-300MB)
5. **UX Consistency:** A single binary works identically everywhere vs. "works on my machine" issues

**Architecture Decision:**
- Distribute as **standalone executables** for end users
- Keep **npm package** for programmatic API access (requires Bun)
- Provide **Docker image** for containerized environments
- Build using **Bun's native compile feature** for optimal bundling

**Executable Usage:**
```bash
# Start the UI server
noetic-ui serve

# With environment variables
NOETIC_UI_WS_PORT=3333 NOETIC_UI_API_PORT=3334 noetic-ui serve

# Check version
noetic-ui --version

# Show help
noetic-ui --help
```

**Graceful Shutdown:**
```bash
# The executable handles SIGINT/SIGTERM properly
curl -fsSL ... | bash  # Install
./noetic-ui serve &      # Start in background
kill -INT %1             # Graceful shutdown
```

**Supported Platforms:**
- macOS (Intel & Apple Silicon)
- Linux (x64 & ARM64)
- Windows (x64)

**Build Process:**
Executables are built using Bun's `--compile` feature in CI/CD:
```bash
bun build --compile --target bun-darwin-arm64 --outfile noetic-ui-darwin-arm64 src/service/index.ts
```

This creates a single binary containing:
- WebSocket server
- REST API server  
- Pre-built Next.js UI
- All dependencies
- Embedded Bun runtime

**Distribution via GitHub Releases:**
- Automated builds on tag push via GitHub Actions
- Cross-platform matrix builds (5 targets)
- Checksums for integrity verification
- Install script for one-line setup

---

## Layout Algorithms

### Grid-Snapped Sequential Layout

The UI uses a **grid-snapped sequential layout algorithm** that arranges execution nodes in execution order, with container nesting, recursive scaling, and orthogonal edge routing.

**Algorithm Overview:**

```typescript
function calculateSequentialLayout(
  nodes: Map<string, ExecutionNode>,
  rootNodeId: string
): { positions: NodePosition[], edges: NodeEdge[] }
```

**Grid System:**

All node positions are quantized to a virtual grid with a configurable cell size (default 20px). This ensures:
- Consistent alignment between nodes regardless of nesting depth
- Uniform edge routing — both the simple rule-based router and the A* fallback produce visually identical segment alignment
- Clean visual rhythm across the entire graph

```typescript
function snapToGrid(value: number, cellSize: number): number {
  return Math.round(value / cellSize) * cellSize;
}
```

**Key Features:**

1. **Execution Order Traversal:**
   - Depth-first traversal starting from root node
   - Visits nodes in actual execution order
   - Builds a linear sequence of execution steps

2. **Sequential Positioning:**
   - Nodes placed vertically (top-to-bottom) with consistent spacing
   - Each node gets position: `{ x, y, width, height, scale }`
   - All coordinates snapped to the virtual grid

3. **Parallel Positioning (Fork & Branch):**
   - Fork and branch children are laid out **horizontally** (side-by-side)
   - All parallel paths start at the same Y coordinate
   - Horizontal spacing between paths prevents overlap
   - Branch: selected/active path at full opacity, unselected paths dimmed

4. **Recursive Container Scaling:**
   - Container nodes (loop, fork, branch, spawn) render as bounding boxes
   - The root container is invisible; its children render at 100% size
   - Below the root, children scale to **50%** of parent size at each nesting level
   - Scale compounds recursively from the first visible container: 50% → 25% → 12.5%
   - Container padding scales proportionally with the scale factor
   - `NodePosition` includes a `scale` field for rendering

5. **Sibling Overlap Prevention:**
   - After positioning children, a collision pass checks sibling bounding boxes
   - Overlapping siblings are pushed apart (horizontally for parallel, vertically for sequential)
   - Applied recursively at every nesting level

6. **Edge Generation:**
   - Sequential edges: solid lines from node N to node N+1
   - Loop edges: dotted teal lines from last child back to first child
   - Fork edges: solid pink lines to parallel execution paths
   - Branch edges: dashed yellow lines to conditional paths
   - Spawn edges: dash-dot indigo lines to child context
   - All edges animated when source node status is 'running'

**Layout Options:**

```typescript
interface SequentialLayoutOptions {
  nodeWidth: 280;           // Base width of node cards
  nodeHeight: 140;          // Base height of node cards
  verticalSpacing: 60;      // Vertical distance between nodes
  horizontalSpacing: 80;    // Horizontal space for parallel paths
  containerPadTop: 50;      // Top padding inside containers (header room)
  containerPadSide: 30;     // Side padding inside containers
  containerPadBottom: 30;   // Bottom padding inside containers
  gridCellSize: 20;         // Virtual grid cell size for snapping
  nestingScale: 0.5;        // Scale factor per nesting level
  startX: 50;               // Initial X position
  startY: 50;               // Initial Y position
}
```

### Orthogonal Edge Router

Edges are rendered as **polylines of horizontal and vertical segments** (90° increments only) with a consistent corner radius at each turn.

**Hybrid Routing Strategy:**

1. **Simple rule-based router** (fast path): Used for the common case where a direct path doesn't cross any node.
   - Picks the anchor side with the largest edge-to-edge gap toward the target
   - For container→child edges (containment), uses vertical anchors aligned to the child's center-x
   - Produces Z-shaped (two turns) or L-shaped (one turn) orthogonal paths depending on anchor sides
   - Connection points are always the center of a node's top, right, bottom, or left edge

2. **A* grid pathfinder** (fallback): Used when the simple path would cross a node bounding box.
   - Overlays the snap grid with node bounding boxes marked as blocked (with margin)
   - Finds shortest orthogonal path avoiding all obstacles
   - First/last waypoints are pinned to exact anchor coordinates for clean node attachment
   - Used for loop-back edges, cross-container edges, and any path that would intersect a node

**Edge Rendering:**

```typescript
interface OrthogonalEdge {
  /** Ordered waypoints forming the polyline (all grid-snapped) */
  waypoints: Array<{ x: number; y: number }>;
  /** Corner radius applied at each turn */
  cornerRadius: number;
}
```

- Corner radius: consistent value (default 6px) applied at every 90° turn via SVG arc commands
- Parallel edges running along the same corridor are offset by several grid cells
- Arrowheads: unfilled chevron marker (thin lines matching edge stroke) at the terminus
- Stroke width: 1.5px for all edge types

**Edge Types:**

| Type | Style | Color | Use Case |
|------|-------|-------|----------|
| `default` | Solid line | Source node status color | Normal sequential flow |
| `conditional` | Dashed (5,5) | Yellow #eab308 | Branch condition paths |
| `fork` | Solid line | Pink #ec4899 | Parallel execution paths |
| `loop` | Dotted (3,3) | Teal #14b8a6 | Loop-back iterations |
| `spawn` | Dash-dot (8,3,3,3) | Indigo #6366f1 | Spawn child connections |

### Click-to-Zoom Navigation

Clicking a container node with children triggers an animated zoom transition:

1. **Zoom in:** Smooth CSS transition (300ms ease-out) centers the container and scales so children appear at 100% base size (`zoom = 1 / scaleAtDepth`)
2. **Breadcrumb trail:** A breadcrumb bar appears in the controls area showing the zoom path (e.g., "Root > Loop > Fork")
3. **Zoom out:** Click background or the breadcrumb back button to animate to the previous zoom level
4. **Nested stacking:** Zoom state is a stack — clicking into a loop, then a fork inside it, pushes two entries. Back pops one at a time.

**Usage:**

```typescript
import { calculateSequentialLayout } from '@noetic/ui/client/lib/sequential-layout';

const { positions, edges } = calculateSequentialLayout(
  trace.nodes,
  trace.rootNodeId,
  {
    nodeWidth: 280,
    nodeHeight: 140,
    gridCellSize: 20,
    nestingScale: 0.5,
  }
);
```

## Data Model

### Agent

Represents a discovered agent in the codebase:

```typescript
interface Agent {
  id: string;                    // Unique agent identifier (hash of file path + export name)
  name: string;                  // Human-readable agent name
  filePath: string;             // Absolute file path to agent definition
  exportName: string;           // Export name (e.g., "default" or "myAgent")
  
  // Discovery metadata
  discoveredAt: number;         // When first discovered
  lastModified: number;         // Last file modification time
  
  // Execution tracking
  runs: Run[];                  // Execution history (sorted by time, newest first)
  runCount: number;            // Total number of runs
  lastRunAt: number | null;    // Most recent execution timestamp
  
  // Configuration (optional)
  description?: string;         // Auto-extracted from JSDoc or comments
  tags?: string[];              // Agent categorization
}
```

### Run

A single execution instance of an agent - the core unit of recording:

```typescript
interface Run {
  id: string;                   // Unique run identifier (UUID)
  agentId: string;              // Reference to parent agent
  
  // Timing
  startTime: number;          // When execution began
  endTime: number | null;     // When execution completed (null if still running)
  durationMs: number | null;
  
  // Status
  status: 'running' | 'completed' | 'error' | 'paused' | 'cancelled';
  
  // Input
  input: unknown;              // The input data that started this run
  inputPreview: string;        // Truncated string representation for display
  
  // Execution data
  trace: ExecutionTrace;        // Full step-by-step execution data
  rootNodeId: string;          // ID of the root execution node
  
  // Timeline data (for scrubbing)
  timelineEvents: TimelineEvent[];  // Ordered list of events for timeline visualization
  currentTimelinePosition: number;    // Current scrub position (0.0 to 1.0, or step index)
  
  // Aggregated metrics
  totalSteps: number;
  totalTokens: TokenUsage;
  totalCost: number;
  maxDepth: number;
  
  // Memory tracking
  memoryBytes: number;         // Total memory used by this run's trace data
  maxMemoryBytes: number;      // Peak memory during execution
  
  // Recording metadata
  recordingVersion: string;    // Version of recording format
  isLive: boolean;            // Whether this is a currently executing run
  
  // Debugging
  breakpointsHit: string[];    // Step IDs where execution paused
  pauseHistory: PausePoint[];  // History of all pause/resume events
}

### Large Trace Handling (v1)

**Current Limitations:**

Initial implementation has basic large trace support:

- **Step Limit:** 1000 steps per run maximum
- **Warning Threshold:** Display warning at 500 steps
- **Hard Stop:** Execution continues, but recording stops at 1000 steps with notification

**Warning Display:**
```
┌─────────────────────────────────────────────────────────┐
│ ⚠️  Large Execution Warning                            │
│                                                          │
│ This run has 750 steps. Performance may degrade          │
│ when viewing traces with many steps.                     │
│                                                          │
│ [Continue Recording]  [Stop Recording]                   │
└─────────────────────────────────────────────────────────┘
```

**Maximum Steps Reached:**
```
┌─────────────────────────────────────────────────────────┐
│ ⚠️  Maximum Steps Reached                               │
│                                                          │
│ Recording stopped at 1000 steps. Execution continues.   │
│                                                          │
│ Trace is complete up to step 1000.                     │
└─────────────────────────────────────────────────────────┘
```

**Lazy Loading:**
- Node details loaded on-demand when clicked
- Timeline markers rendered progressively
- Simple virtualization: render visible nodes + buffer of 50

**Future Improvements:**
- Virtual scrolling for 10,000+ steps
- Timeline aggregation/LOD when zoomed out
- Configurable step limits
- Auto-segmentation of long runs

### Execution Node

```typescript
interface ExecutionNode {
  id: string;                    // Unique execution instance ID
  stepId: string;                // Static step definition ID
  kind: StepKind;                // 'run' | 'llm' | 'tool' | 'branch' | 'fork' | 'spawn' | 'loop'
  parentId: string | null;       // Parent execution node (null for root)
  depth: number;               // Nesting depth
  
  // Timing
  startTime: number;           // Unix timestamp (ms)
  endTime: number | null;    // null until complete
  durationMs: number | null;
  
  // Status
  status: 'pending' | 'running' | 'paused' | 'completed' | 'error' | 'cancelled';
  error?: NoeticError;
  
  // Data
  input: unknown;
  output: unknown | null;
  contextSnapshot: ContextSnapshot;
  
  // Step-specific data
  stepData: StepData;
  
  // Relationships
  children: string[];          // Child execution IDs (for spawn/loop/fork)
  forkPaths?: string[][];      // For fork: array of path node arrays
}

type StepData =
  | RunStepData
  | LLMStepData
  | ToolStepData
  | BranchStepData
  | ForkStepData
  | SpawnStepData
  | LoopStepData;

interface RunStepData {
  description?: string;          // Optional step description
}

interface LLMStepData {
  model: string;                 // LLM model identifier (e.g., 'gpt-4', 'claude-3-opus')
  messages: MessageItem[];         // Conversation history
  toolCalls: FunctionCallItem[];   // Tool/function calls made by LLM
  systemPrompt?: string;         // System prompt sent to LLM
  tokenUsage: TokenUsage;        // Token consumption statistics
  cost: number;                   // Cost in USD for this LLM call
}

interface ToolStepData {
  toolName: string;              // Name of the tool being invoked
  arguments?: unknown;            // Arguments passed to the tool
  result?: unknown;               // Tool execution result
}

interface BranchStepData {
  branchType: 'dynamic';          // Type of branching (currently only dynamic)
  selectedPath?: number;          // Which branch path was selected (0-indexed)
  condition?: string;            // Condition evaluated for branching
}

interface ForkStepData {
  mode: 'race' | 'all' | 'settle';  // Fork execution mode
  pathCount: number;              // Number of parallel paths
  winnerPath?: number;             // For race mode: which path won
}

interface SpawnStepData {
  childId: string;               // ID of the spawned child step
  childKind?: string;             // Kind of the child step
}

interface LoopStepData {
  stepCount: number;             // Number of steps inside the loop body
  currentIteration?: number;      // Current iteration number (0-indexed)
  maxIterations?: number;         // Maximum iterations configured
}

interface ProvideStepData {
  providerId?: string;            // Provider identifier
  provides?: unknown;             // Value being provided
  description?: string;           // Optional description
}

// ... other step data types
```

### Step Detail Requirements

Each step rendered in the sequential layout requires comprehensive data for proper visualization. The following span attributes must be set by the core runtime:

**Common Attributes (All Step Types):**

```typescript
// Required for all steps
span.setAttribute('stepKind', step.kind);     // Step type identifier
span.setAttribute('stepId', step.id);        // Unique step ID
span.setAttribute('input', JSON.stringify(input));  // Input data
span.setAttribute('depth', ctx.depth);       // Execution depth

// Set at completion
span.setAttribute('output', JSON.stringify(result));     // Output data
span.setAttribute('tokenInput', ctx.tokens.input);         // Input tokens
span.setAttribute('tokenOutput', ctx.tokens.output);     // Output tokens
span.setAttribute('totalTokens', totalTokens);           // Total tokens
span.setAttribute('cost', ctx.cost);                     // Cost in USD
span.setAttribute('state', JSON.stringify(ctx.state));   // Context state
```

**Step-Specific Attributes:**

| Step Kind | Required Attributes | Optional Attributes |
|-------------|---------------------|---------------------|
| **llm** | `model` | `systemPrompt`, `messages`, `toolCalls` |
| **tool** | `toolName` | `toolArguments`, `toolResult` |
| **fork** | `forkMode`, `forkPathCount` | `winnerPath` |
| **loop** | `loopStepCount` | `currentIteration`, `maxIterations` |
| **spawn** | `spawnChildId` | `spawnChildKind` |
| **branch** | `branchType` | `selectedPath`, `condition` |
| **run** | - | `stepDescription` |
| **provide** | - | `providerId`, `provides`, `stepDescription` |

**Error Handling:**

When steps fail, additional error attributes should be set:

```typescript
span.setAttribute('error', 'true');
span.setAttribute('errorMessage', error.message);
span.setAttribute('errorCode', error.code);  // If available
```

**Example: LLM Step Setup:**

```typescript
// At step start
span.setAttribute('stepKind', 'llm');
span.setAttribute('stepId', step.id);
span.setAttribute('input', JSON.stringify(input));
span.setAttribute('depth', ctx.depth);
span.setAttribute('model', step.model);
if (step.system) {
  span.setAttribute('systemPrompt', step.system);
}

// At step completion  
span.setAttribute('output', JSON.stringify(result));
span.setAttribute('tokenInput', ctx.tokens.input);
span.setAttribute('tokenOutput', ctx.tokens.output);
span.setAttribute('cost', ctx.cost);
```

**Validation:**

The UI exporter validates step data completeness. Missing required fields will result in:
- Default values (e.g., 'unknown' for model names)
- Empty arrays (e.g., `messages: []`)
- Zero values (e.g., `cost: 0`)
- Warnings in console during development mode

**Extending Step Types:**

To add a new step kind with full UI support:

1. **In Core:** Set all required span attributes during execution
2. **In UI:** Register a step data extractor:
   ```typescript
   import { registerStepDataExtractor } from '@noetic/ui/runtime';
   
   registerStepDataExtractor('newStep', (spanAttrs, tokenUsage, cost) => ({
     customField: spanAttrs.customField,
     tokenUsage,
     cost,
   }));
   ```
3. **In UI:** Add a node component for rendering (optional)

**Node Rendering:**

The UI uses the step's `kind` field to determine:
- Which node component to render
- Color scheme and icon
- Inspector tabs and content
- Timeline marker appearance

Default rendering falls back to `RunNode` for unknown step kinds.

---
### Context Snapshot

```typescript
interface ContextSnapshot {
  depth: number;
  stepCount: number;
  tokens: TokenUsage;
  cost: number;
  elapsedMs: number;
  state: unknown;
  itemLogLength: number;
}
```

### Execution Trace

```typescript
interface ExecutionTrace {
  traceId: string;             // UUID for this execution
  rootStepId: string;          // ID of top-level step
  startTime: number;
  endTime: number | null;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  nodes: Map<string, ExecutionNode>;
  rootNodeId: string;
}
```

### Storage Management

**Storage Model:**
- **User-controlled deletion** - No automatic cleanup of traces
- **Raw storage** - Traces stored uncompressed for fast access
- **Compression** - Future enhancement (marked for v2)
- **Visual indicators** - Storage usage displayed in UI

**Storage Tracking:**
```typescript
interface StorageMetrics {
  totalRuns: number;           // Total runs stored across all agents
  totalSizeBytes: number;      // Total storage used
  availableBytes: number;      // Available disk space
  byAgent: Map<string, {       // Per-agent breakdown
    runCount: number;
    sizeBytes: number;
  }>;
}
```

**UI Storage Bar:**
```
┌─────────────────────────────────────────────────────────┐
│ Storage: 45 runs · 234 MB used · 1.2 GB available      │
│ [████████░░░░░░░░░░░░] 16% used                        │
│                                                         │
│ ⚠️ Warning at 80%   🗑️ Clear all runs                │
└─────────────────────────────────────────────────────────┘
```

**Storage Indicators:**
- **Visual bar** showing used vs available space
- **Run count** and **size in MB/GB**
- **Warning threshold** at 80% capacity (orange bar)
- **Critical threshold** at 95% capacity (red bar)
- **No enforced limits** - users manage their own storage

**User Actions:**
- **Clear all runs** - Delete all stored traces (confirmation required)
- **Clear agent runs** - Delete all runs for a specific agent
- **Clear single run** - Delete individual run
- **Export before delete** - Option to export trace before deletion
- **Sort by size** - Find largest traces to delete first

**Storage Location:**
- **Default:** `./.noetic/ui/traces/` (in project root)
- **Detection:** Automatically finds project root by locating `package.json`
- **Configurable** via `NOETIC_UI_STORAGE_PATH` env var
- **Fallback:** `~/.noetic-ui/traces/` if no project root found
- **Storage backend:** File system (memory/redis for future)

---

## WebSocket Protocol

### Server → Client Messages

```typescript
type ServerMessage =
  | { type: 'execution.start'; trace: ExecutionTrace }
  | { type: 'node.start'; node: ExecutionNode }
  | { type: 'node.complete'; nodeId: string; output: unknown; durationMs: number }
  | { type: 'node.error'; nodeId: string; error: NoeticError }
  | { type: 'node.pause'; nodeId: string; reason: 'breakpoint' | 'step' | 'error' }
  | { type: 'node.data'; nodeId: string; data: Partial<ExecutionNode> }
  | { type: 'execution.complete'; traceId: string; summary: ExecutionSummary }
  | { type: 'execution.error'; traceId: string; error: NoeticError }
  | { type: 'pong'; timestamp: number };
```

### Client → Server Messages

```typescript
type ClientMessage =
  | { type: 'execution.list' }  // List active/completed executions
  | { type: 'execution.get'; traceId: string }
  | { type: 'execution.replay'; traceId: string; fromNodeId?: string }
  | { type: 'node.stepOver'; traceId: string; nodeId: string }
  | { type: 'node.stepInto'; traceId: string; nodeId: string }
  | { type: 'node.stepOut'; traceId: string; nodeId: string }
  | { type: 'node.resume'; traceId: string; nodeId: string }
  | { type: 'breakpoint.add'; stepId: string; condition?: string }
  | { type: 'breakpoint.remove'; stepId: string }
  | { type: 'ping'; timestamp: number };
```

### WebSocket Reliability

**Connection Management:**

**Auto-Reconnection:**
- **Exponential backoff:** 1s → 2s → 4s → 8s → max 30s between retries
- **Max retry duration:** 5 minutes, then show manual reconnect button
- **Visual indicator:** Connection status shown in UI header
  - 🟢 Green dot: Connected
  - 🟡 Yellow dot: Reconnecting (attempt in progress)
  - 🔴 Red dot: Disconnected (retry limit reached)

**Heartbeat Protocol:**
- **Client ping:** Every 30 seconds
- **Server pong:** Response within 5 seconds
- **Missed heartbeats:** After 2 missed pongs (10s), trigger reconnection

**Message Buffering:**
- **Server-side buffer:** Messages queued during disconnection
- **Buffer size:** Up to 1000 messages (configurable)
- **Buffer overflow:** Oldest messages dropped when full
- **Client sync:** On reconnect, server sends "missed events" summary
- **Best effort:** If buffer exceeds limit, execution continues but trace may be incomplete

**Reconnection Flow:**
```
1. Connection drops
2. Show yellow "Reconnecting..." indicator
3. Attempt reconnection with exponential backoff
4. On success:
   - Green indicator restored
   - Sync missed events from buffer
   - Continue real-time updates
5. On failure (after 5 min):
   - Show red "Disconnected" indicator
   - Display "Reconnect" button
   - Show last successful sync time
```

**Graceful Degradation:**
- If disconnected during live execution, data continues recording locally
- On reconnect, recorded data syncs to UI
- Warning shown if trace is incomplete: "⚠️ Connection lost at [timestamp]. Some events may be missing."

---

## UI Components

### Layout Structure (Three-Panel Design)

```
┌─────────────────────────────────────────────────────────────┐
│  Left Sidebar    │      Center Canvas       │  Right Panel  │
│  (Agent Browser) │    (Node Graph)          │  (Inspector)  │
│                  │                          │               │
│  ▼ agents/       │     ┌──────────┐         │  ┌─────────┐  │
│  ├─ review.ts    │     │  Node 1  │────────▶│  │session  │  │
│  │  ├─ 🟢 2m     │     └──────────┘         │  │attempt  │  │
│  │  ├─ ⚪ 1h     │          │               │  │events   │  │
│  │  └─ 🔴 3h     │     ┌────┴────┐         │  └─────────┘  │
│  ▶ workflow/     │     │         │         │  ┌─────────┐  │
│                  │  ┌──┴──┐   ┌──┴──┐      │  │Content  │  │
│                  │  │Node │   │Node │      │  │         │  │
│                  │  │ 2   │   │ 3   │      │  │         │  │
│                  │  └──┬──┘   └──┬──┘      │  │         │  │
│                  │     └────┬────┘         │  └─────────┘  │
│                  │          │               │               │
├─────────────────────────────────────────────────────────────┤
│  Bottom Playback Bar                  ● Connected  📡        │
│  ⏮  ⏴  ⏯  ⏵  ⏭     Timeline    1x  2x  5x  10x        │
└─────────────────────────────────────────────────────────────┘
```

**Panel Functions:**

1. **Left Sidebar (Agent Browser)** - Browse agents and their execution history
2. **Center Canvas (Node Graph)** - Visual execution flow with time-travel scrubbing
3. **Right Panel (Inspector)** - Detailed data for selected step/run
4. **Bottom Bar (Playback)** - Time-travel controls and connection status

**Connection Indicator:**
- **Location:** Bottom bar or header (persistent visibility)
- **States:**
  - 🟢 **Green dot** "Connected" - Live WebSocket connection
  - 🟡 **Yellow dot** "Connecting..." - Reconnection in progress
  - 🔴 **Red dot** "Disconnected" - Connection lost, manual reconnect needed

### 1. Left Sidebar (Agent Browser)

The left sidebar serves as an agent and execution history browser:

**Top-Level: Agents**
- **Agent entries** showing:
  - Agent name (bold)
  - File path (monospace, truncated with ellipsis if long)
  - Last run timestamp
  - Status indicator dot (🟢 active, 🔴 error, ⚪ inactive)
- **Expand/collapse** arrow to show/hide runs
- **Search/filter** box at top to find agents by name or path
- **Group by:** file directory, agent name, recent activity

**Second Level: Runs**
When an agent is expanded, show its execution runs:
- **Run entries** showing:
  - Run timestamp (relative: "2 min ago", absolute on hover)
  - Status icon (🟡 running, 🟢 completed, 🔴 error, 🟠 paused)
  - Duration (e.g., "25.5 s", "17m 43s")
  - Input preview (truncated first 50 chars)
  - Token counts (input↑ output↓) and cost
- **Live runs** animate with pulsing border
- **Click to load** the run's trace into the center canvas
- **Context menu** (right-click) for actions:
  - Replay run
  - Export trace
  - Compare with another run
  - Delete (if persisted)

**Navigation Features:**
- **Sort options:** recent first, oldest first, duration, cost
- **Filter:** show only errors, show only completed, show running
- **Pin runs** to keep them at top
- **Batch selection** for comparing multiple runs
- **Auto-refresh** for live agents (new runs appear automatically)

```
┌─────────────────────────────┐
│ 🔍 Search agents...          │
├─────────────────────────────┤
│                             │
│ ▼ src/agents/               │
│ ├─ code-review-agent.ts    │
│ │  ├─ 🟢 2 min ago · 45s   │
│ │  ├─ ⚪ 1 hour ago · 2m    │
│ │  └─ 🔴 3 hours ago · 30s  │
│ │                           │
│ ▶ src/workflows/            │
│ ├─ pr-analysis.ts          │
│ │  └─ 🟡 5 min ago · LIVE  │
│ │                           │
│ ▶ lib/eval/                 │
│ └─ test-runner.ts          │
│    └─ ⚪ 2 days ago · 5m   │
│                             │
└─────────────────────────────┘
```

### Agent Discovery

**Discovery Strategy: Hybrid Approach**

Combines automatic discovery with manual registration for maximum flexibility.

**Phase 1: Build-Time Static Analysis (Primary)**

Scans codebase at build/dev server start to find agents:

- **File patterns scanned:**
  - `**/*.agent.ts`
  - `**/agents/**/*.ts`
  - `**/*.noetic.ts`
  - Configurable via `NOETIC_UI_AGENT_PATTERNS` env var

- **Detection method:**
  - AST parsing of TypeScript/JavaScript files
  - Looks for `AgentHarness` constructor calls
  - Extracts: file path, export name, variable name
  - Parses JSDoc comments for agent descriptions

- **Discovery output:**
```typescript
interface DiscoveredAgent {
  id: string;                    // Hash of (filePath + exportName)
  filePath: string;             // Absolute path
  exportName: string;           // "default", "myAgent", etc.
  variableName: string;         // Variable name in code (optional)
  name: string;                 // Inferred or JSDoc @name
  description?: string;         // JSDoc description
  discoveredAt: number;        // Timestamp
  discoveryMethod: 'static';
}
```

- **Re-scan triggers:**
  - Initial dev server start
  - Manual "Refresh agents" button
  - File watcher (future enhancement)

**Phase 2: Manual Registration (Fallback)**

For agents not caught by static analysis or dynamically created:

```typescript
// Register an agent manually
import { registerAgent } from '@noetic/ui/runtime';

registerAgent({
  id: 'custom-agent-1',         // Unique identifier
  filePath: './src/custom.ts',  // Source location
  name: 'Custom Agent',         // Display name
  description: 'My custom agent',
  harness: myAgentHarness,      // Reference to harness
});
```

**Manual Registration Features:**
- **"Add Agent" button** in sidebar
- Opens file picker or text input for module path
- Dynamically imports and registers
- Persisted in local storage for next session
- **"Register current file"** code action in editor extensions (future)

**Agent Status in Browser:**
- **Discovered (static)** - Found via build-time analysis
- **Registered (manual)** - Added manually via `registerAgent()`
- **Active** - Currently running or has recent runs
- **Stale** - No runs in last 30 days

**Discovery Refresh:**
```
┌─────────────────────────────┐
│ 🔍 Search agents...    🔄   │  ← Manual refresh button
├─────────────────────────────┤
│ ▼ src/agents/               │
│ ├─ review.ts (auto)       │
│ ├─ custom.ts (manual) +   │  ← Manual badge
└─────────────────────────────┘
```

**Discovery Status Panel:**
```
┌─────────────────────────────┐
│ Discovery                   │
├─────────────────────────────┤
│ Last scan: 5 min ago        │
│ Files scanned: 47           │
│ Agents found: 3             │
│ Manual registrations: 1       │
│                             │
│ [Rescan project]            │
│ [Add agent manually]        │
└─────────────────────────────┘
```

**Future Enhancements:**
- Runtime hook discovery (Phase 3)
- File watcher for automatic re-scan
- Editor extension for one-click registration
- Agent template/snippets generation

---

### 2. Node Graph Canvas (Center)

**Node Card Design:**
```
┌─────────────────────────────────────┐
│  [ICON]  STEP_KIND  │  BRANCH 2     │
│  Step Title Goes Here               │
│  step_id_snake_case                 │
│  ┌────────┐ ┌────────┐ ┌────────┐  │
│  │tool1   │ │tool2   │ │pattern │  │
│  └────────┘ └────────┘ └────────┘  │
│  2 attempts           │  [STATUS]   │
│                              25.5 s │
└─────────────────────────────────────┘
```

- **Card styling:**
  - Rounded corners (4px radius)
  - Subtle border with color-coded accent
  - Semi-transparent dark background
  - Shadow for depth
  
- **Header row:**
  - Step kind icon + label (e.g., "LLM", "TOOL")
  - Status icon (✓ ▶ ⏸ ✗ ○ ⊘) with color coding
  
- **Content:**
  - Bold step title
  - Monospace step ID below
  - Tool/pattern tags as small pills
  - Attempt count (e.g., "1 attempt", "2 attempts")
  - Duration on right side
  
- **Color scheme by status:**
  - **DONE** (green accent): #10b981 border, #065f46 background
  - **QUEUED** (gray accent): #6b7280 border, #374151 background
  - **FOCUS/ACTIVE** (blue accent): #3b82f6 border, #1e40af background
  - **ERROR** (red accent): #ef4444 border, #991b1b background
  - **PAUSED** (yellow accent): #f59e0b border, #92400e background

- **Connection edges:**
  - Orthogonal routing (90° segments only) with consistent corner radius
  - Connect from/to center of top, right, bottom, or left edge of nodes
  - Thin 1.5px stroke with unfilled arrowheads
  - Color encodes connection type (kind color), not node status
  - Edges route around nodes, never through them
  - Parallel edges offset by grid cells for readability
  - Animated pulse for active execution

- **Canvas features:**
  - **Pan/Zoom** - Infinite canvas with mouse drag and scroll wheel
  - **Auto-fit** - Fit graph to viewport button
  - **Click-to-zoom** - Click container nodes to zoom in so children appear at 100% size; breadcrumb trail for navigation back
  - **Grid background** - Subtle dot grid pattern (also used as snap grid for layout)

### 3. Right Inspector Panel

**Tab Navigation:**
- session | attempt | events
- Pill-style tabs with active state highlight

**Content Display:**
- **Monospace text** for code/system prompts
- **JSON tree** for structured data with syntax highlighting
- **Scrollable areas** with custom dark scrollbar
- **Collapsible sections** for nested data

**Example content layout:**
```
┌────────────────────────────────────┐
│  session │ attempt │ events      │
├────────────────────────────────────┤
│                                    │
│  Return exactly one JSON object    │
│  and nothing else...               │
│                                    │
│  {                                   │
│    "route": "collect_review",      │
│    "summary": "short..."           │
│  }                                   │
│                                    │
│  I'm reading the saved CI state    │
│  for the current branch head...    │
│                                    │
├────────────────────────────────────┤
│  [Follow] [Overview]              │
└────────────────────────────────────┘
```

### 4. Bottom Playback Bar (Time Travel Controls)

The playback bar enables time-travel debugging - scrub back and forth through recorded execution:

**Transport Controls:**
```
┌────────────────────────────────────────────────────────────┐
│  Step Name                    │◄◄  ◄  ▶▶  ►  ►►│  Speed   │
│  9 / 24 · step-9 · 70%       │        ◯        │ 1x 2x 5x │
│  REC ● 0:45:23               │    [Timeline]   │  ▶ Live  │
└────────────────────────────────────────────────────────────┘
```

**Architecture Note:** WebSocket provides bidirectional communication needed for control commands (pause, resume, breakpoints). Server-Sent Events (SSE) could be an alternative for server→client streaming with separate HTTP endpoints for client→server commands, but WebSockets provide lower latency and simpler implementation for real-time debugging.

**Transport Buttons:**
- ⏮ **First** - Jump to start of execution
- ⏴ **Step Back** - Move to previous step (maintains state context)
- ⏯ **Play/Pause** - Auto-play through execution at selected speed
- ⏵ **Step Forward** - Move to next step
- ⏭ **Last/Next Major** - Jump to end or next breakpoint

**Timeline with Event Markers:**

A dedicated timeline track sits underneath the transport controls, with the draggable playhead serving as the interactive scrubbing mechanism:

```
Timeline View (spacing = wall clock time):
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ●        ●  ●  ◆        ●  ●  ◆  ●  ●  ●              ●  ●  ○   │
│  ▲                                                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
     ▲ = Playhead (drag to scrub)
     
Spacing between markers represents actual time elapsed:
  ●──────●  = Longer duration between steps
  ●  ●      = Shorter duration between steps
  
Event marker types:
  ● = Step completed    ◆ = Branch/Fork point    ○ = Pending/Not executed
```

**Event Markers:**
- **Vertical markers** along the timeline representing each executed step
- **Color-coded by step kind:**
  - Purple - LLM steps
  - Orange - Tool steps  
  - Cyan - Run steps
  - Yellow - Branch steps
  - Pink - Fork steps (multiple markers for parallel paths)
  - Indigo - Spawn steps
  - Teal - Loop steps
- **Height indicates depth** - taller markers for deeper nesting levels
- **Status glow:**
  - Green - completed successfully
  - Red - error occurred
  - Blue - currently at this step
  - Yellow - paused at breakpoint

**Draggable Playhead (The Scrubbing Mechanism):**
- **The playhead IS the scrubber** - grab and drag it to scrub through execution
- **Drag anywhere on the timeline track** - the playhead follows your cursor
- **Real-time updates** during drag:
  - Canvas updates instantly to show execution state at that position
  - Right panel updates with current step's data
  - Position indicator updates ("Step 9 / 24")
- **Snap-to-step behavior:**
  - While dragging, playhead smoothly follows cursor
  - On release, snaps to nearest step marker
  - Option: "Free scrub" mode for smooth interpolation between steps
- **Visual feedback during drag:**
  - Playhead grows slightly larger when grabbed
  - Glow effect around playhead
  - Tooltip shows current step info while dragging
  - Timeline highlights the current segment

**Click Interactions:**
- **Click on marker** - playhead jumps to that step, execution state updates
- **Click anywhere on timeline** - playhead jumps to nearest step at that position
- **Shift+click** - select range for comparison
- **Hover over marker** - tooltip shows step name, timestamp, duration

**Timeline Tracks:**
- **Primary track** - shows all steps in chronological order
- **Fork track** - when inside a fork, shows parallel execution lanes
  - Each lane represents one fork path
  - Lanes stacked vertically under main timeline
  - Playhead spans all active lanes simultaneously
- **Loop track** - when inside a loop, shows iterations
  - Iteration markers grouped visually
  - Expand to see individual iteration steps
  - Collapse to single "LOOP" marker

**Timeline Controls:**
- **Zoom** - pinch gesture or +/- buttons to see more/fewer steps
  - Zoom out: see entire execution at a glance
  - Zoom in: focus on specific section with detailed markers
- **Fit to view** - auto-zoom to show all steps
- **Bookmark markers** - diamond icons on timeline for breakpoints

**Real-Time Scrubbing Behavior:**
- **Immediate response** - canvas and panels update within 16ms of dragging
- **Smooth drag** - no lag, playhead follows cursor precisely
- **Lazy loading** - detailed data fetched on-demand when scrubbing
- **Cache recent states** - last 50 scrubbed positions cached for instant return
- **Animation** - smooth 100ms transition when jumping between distant steps
- **History tracking** - browser-style back/forward for scrub positions

**Time-Travel Features (Observational Only):**
- **View stored state** - When scrubbing to a point, UI displays the stored snapshot of execution state at that moment
- **Branch visualization** - For fork steps, timeline shows all parallel paths
- **History stack** - Navigate backward/forward through your browsing history (like browser back/forward)
- **Snapshot comparison** - Compare two points in time side-by-side

**Important:** Time-travel displays stored data only. No code is re-executed. All inputs, outputs, and state are read from the recorded trace.

**Playback Modes:**
- **1x, 2x, 5x, 10x** - Speed multiplier for auto-play
- **Live** - Real-time following of active execution
- **Recorded** - Replaying from stored trace
- **Step** - Manual stepping mode

**Current Position Display:**
- Step name and number ("Step 9 / 24")
- Execution depth and context
- Percentage through execution

### 5. Node Types (Visual Variants)

Each step kind has a distinct visual treatment:

**LLM Step:**
- Icon: 💬 or "LLM"
- Color: Purple accent (#8b5cf6)
- Shows: Model name, token count
- Badge: "LLM"

**Tool Step:**
- Icon: 🔧 or "TOOL"
- Color: Orange accent (#f97316)
- Shows: Tool name prominently
- Badge: "TOOL"

**Run Step:**
- Icon: ⚡ or "RUN"
- Color: Cyan accent (#06b6d4)
- Shows: Function name or description
- Badge: "RUN"

**Branch Step:**
- Icon: 🔀 or diamond shape
- Color: Yellow accent (#eab308)
- Shows: Branch condition
- Badge: "BRANCH"

**Fork Step:**
- Icon: ⫚ or parallel lines
- Color: Pink accent (#ec4899)
- Shows: Fork mode (race/all/settle)
- Badge: "FORK"

**Spawn Step:**
- Icon: 📦 or nested squares
- Color: Indigo accent (#6366f1)
- Shows: Context depth indicator
- Badge: "SPAWN"
- Expandable to show child graph

**Loop Step:**
- Icon: 🔄 or circular arrow
- Color: Teal accent (#14b8a6)
- Shows: Iteration count
- Badge: "LOOP"
- Shows iteration number in badge (e.g., "LOOP · 3/5")

### 6. Interactive States

**Node Hover:**
- Subtle glow effect
- Slight scale up (1.02x)
- Cursor changes to pointer
- Shows tooltip with quick info

**Node Selected:**
- Bright border highlight
- Shadow intensifies
- Right panel updates
- Auto-scroll to node if off-screen

**Node Running:**
- Animated border (pulsing)
- Status icon shows ▶
- Duration counter increments live

**Node Paused (Breakpoint):**
- Yellow border pulse
- "PAUSED" badge
- Playback controls active
- Inspector shows current state

### 7. Theme

**Theme Modes:**

Noetic UI supports three theme modes:
1. **System** (default) - Automatically follows OS preference via `prefers-color-scheme`
2. **Dark** - Force dark mode regardless of system setting
3. **Light** - Force light mode regardless of system setting

**Dark Theme:**
```
Background: #0f172a (slate-900)
Canvas: #1e293b (slate-800)
Node Background: rgba(30, 41, 59, 0.8)
Node Border: #334155 (slate-700)
Text Primary: #f1f5f9 (slate-100)
Text Secondary: #94a3b8 (slate-400)
Timeline Track: #1e293b (slate-800)
Timeline Markers: 
  - LLM: #8b5cf6 (purple-500)
  - Tool: #f97316 (orange-500)
  - Run: #06b6d4 (cyan-500)
  - Branch: #eab308 (yellow-500)
  - Fork: #ec4899 (pink-500)
  - Spawn: #6366f1 (indigo-500)
  - Loop: #14b8a6 (teal-500)
Accent Colors:
  - Success: #10b981 (emerald-500)
  - Info: #3b82f6 (blue-500)
  - Warning: #f59e0b (amber-500)
  - Error: #ef4444 (red-500)
```

**Light Theme:**
```
Background: #f8fafc (slate-50)
Canvas: #f1f5f9 (slate-100)
Node Background: #ffffff
Node Border: #e2e8f0 (slate-200)
Text Primary: #0f172a (slate-900)
Text Secondary: #64748b (slate-500)
Timeline Track: #e2e8f0 (slate-200)
Timeline Markers:
  - LLM: #7c3aed (purple-600)
  - Tool: #ea580c (orange-600)
  - Run: #0891b2 (cyan-600)
  - Branch: #ca8a04 (yellow-600)
  - Fork: #db2777 (pink-600)
  - Spawn: #4f46e5 (indigo-600)
  - Loop: #0d9488 (teal-600)
Accent Colors:
  - Success: #059669 (emerald-600)
  - Info: #2563eb (blue-600)
  - Warning: #d97706 (amber-600)
  - Error: #dc2626 (red-600)
```

**Theme Detection & Persistence:**
- Default: `system` mode (queries `window.matchMedia('(prefers-color-scheme: dark)')`)
- User preference stored in `localStorage` key `noetic-ui-theme`
- Toggle in settings panel or keyboard shortcut `Cmd/Ctrl + Shift + T`
- Theme changes apply instantly without page reload
- CSS custom properties for dynamic theme switching

---

## API Reference

### Runtime Integration

```typescript
import { NoeticUITraceExporter } from '@noetic/ui/runtime';

const exporter = new NoeticUITraceExporter({
  port: 3333,                    // WebSocket server port
  host: 'localhost',             // WebSocket server host
  bufferSize: 100,               // Max events to buffer before dropping
  flushIntervalMs: 100,          // How often to flush events
});

setTraceExporter(exporter);
```

```typescript
import { createDebugHarness } from '@noetic/ui/runtime';

const harness = createDebugHarness({
  name: 'my-agent',
  initialStep: myStep,
  debugger: {
    // Breakpoint configuration
    breakpoints: [
      { stepId: 'validate-step', condition: 'input.attempt > 3' },
      'loop-step',  // Simple step ID breakpoint
    ],
    
    // Behavior settings
    pauseOnError: true,
    pauseOnSpawn: false,
    autoStart: true,  // If false, waits for UI signal
    
    // External control (optional)
    controller: externalController,  // For programmatic control
  }
});

// Execution automatically pauses at breakpoints
const result = await harness.execute('user input');
```

### CLI Usage

```bash
# Start the UI server
npx @noetic/ui serve [--port 3333] [--host 0.0.0.0]

# Run with debugging enabled (spawns server automatically)
npx @noetic/ui run -- npm start

# Replay a saved trace
npx @noetic/ui replay <trace-file.json>
```

### WebSocket API

See `src/shared/protocol.ts` for complete message types.

### REST API

The UI server exposes a REST API for querying agents and runs. All endpoints return JSON with a standard response wrapper:

```typescript
interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
```

**Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents` | List all registered agents |
| `DELETE` | `/api/agents/{agentId}` | Delete an agent and all its runs |
| `GET` | `/api/agents/{agentId}/runs` | List all runs for an agent |
| `GET` | `/api/agents/{agentId}/runs/{runId}` | Get a specific run with full trace |
| `DELETE` | `/api/agents/{agentId}/runs/{runId}` | Delete a specific run |
| `GET` | `/api/metrics` | Get storage metrics (total runs, size, per-agent stats) |
| `GET` | `/health` | Health check endpoint |

**Examples:**

```bash
# List all agents
curl http://localhost:3334/api/agents

# Get runs for an agent
curl http://localhost:3334/api/agents/my-agent/runs

# Get a specific run with trace
curl http://localhost:3334/api/agents/my-agent/runs/run-uuid-123

# Get storage metrics
curl http://localhost:3334/api/metrics
```

**Note:** Runs are accessed as nested resources under agents (`/api/agents/{agentId}/runs/{runId}`) following REST best practices. The run ID alone is not sufficient to identify a run - it must be qualified by the agent ID.

---

## Dependencies

### Runtime Dependencies (Server)

- `ws` (^8.16.0) - WebSocket server/client for real-time communication
- `zod` (^4.0.0) - Schema validation (shared with core)
- `next` (^14.2.0) - Next.js framework for web UI
- `react` (^18.2.0) / `react-dom` (^18.2.0) - UI framework
- `zustand` (^5.0.0) - State management

**Note:** These are all bundled into the standalone executable. End users don't need to install them.

### Development Dependencies

- `bun-types` - Bun runtime types
- `typescript` (^6.0.2) - TypeScript compiler
- `@types/node`, `@types/react`, `@types/react-dom`, `@types/ws` - Type definitions
- `tailwindcss`, `postcss`, `autoprefixer` - Styling

### Build Tooling

- **Bun** (>=1.0.0) - Required for:
  - Development and testing
  - Building standalone executables (`bun build --compile`)
  - Running from source (`bun src/service/index.ts`)
  - Cross-platform compilation

### Peer Dependencies

- `@noetic/core` (workspace:*) - The core framework being debugged

### Distribution Strategy

**End Users (Standalone Executable):**
- Zero dependencies required
- Single binary (~50-110MB) includes everything
- No package manager needed
- No runtime installation required

**Developers (Source):**
- Bun 1.0+ required
- `bun install` to fetch dependencies
- `bun run build:exe` to create executables

**Programmatic API Users:**
- Bun 1.0+ required
- `bun add -D @noetic/ui` to install
- Import from `@noetic/ui/service` or `@noetic/ui/runtime`

---

## Configuration

### v1 MVP - Essential Configuration

Minimal configuration needed to get started:

#### Environment Variables

```bash
NOETIC_UI_ENABLED=true         # Enable UI integration (required)
NOETIC_UI_WS_PORT=3333         # WebSocket server port (optional, default: 3333)
NOETIC_UI_API_PORT=3334        # REST API/Web UI port (optional, default: 3334)
NOETIC_UI_HOST=127.0.0.1       # Bind address (optional, default: 127.0.0.1)
NOETIC_UI_THEME=system         # Theme: system, dark, light (optional, default: system)
```

**Note on Port Configuration:**
The UI uses two ports:
- **WebSocket (3333):** Real-time communication with agents
- **API/Web UI (3334):** REST API and browser interface

This separation allows independent scaling and firewall configuration.

#### Storage Location

Traces are stored in the project directory by default:

```
.your-project-root/
├── .noetic/
│   └── ui/
│       ├── traces/          # Execution trace files
│       └── agents.json      # Agent registry
├── src/
└── package.json
```

**Storage Path Resolution:**
1. Checks `NOETIC_UI_STORAGE_PATH` environment variable
2. Detects project root (directory containing `package.json`)
3. Creates `.noetic/ui/traces/` in project root
4. Falls back to `~/.noetic-ui/traces/` if no project root found

This ensures traces stay with the project they're debugging.

#### Config File (noetic.ui.json) - Optional

```json
{
  "wsPort": 3333,
  "apiPort": 3334,
  "host": "127.0.0.1",
  "theme": "system",
  "storagePath": "./.noetic/ui/traces"
}
```

**That's it.** The UI works with just `NOETIC_UI_ENABLED=true`.

---

### Extended Configuration

Additional options for advanced use cases:

#### All Environment Variables

```bash
# Core
NOETIC_UI_ENABLED=true         # Enable UI integration
NOETIC_UI_WS_PORT=3333         # WebSocket server port
NOETIC_UI_API_PORT=3334        # REST API/Web UI port
NOETIC_UI_HOST=127.0.0.1       # Bind address (use 0.0.0.0 for remote access)
NOETIC_UI_SHUTDOWN_TIMEOUT=10000  # Graceful shutdown timeout in ms (default: 10000)

# Storage
NOETIC_UI_STORAGE_PATH=./.noetic/ui/traces  # Trace storage location

# UI
NOETIC_UI_THEME=system         # Theme: system, dark, light
NOETIC_UI_AUTO_OPEN=true       # Auto-open browser on start (future)

# Advanced (future)
NOETIC_UI_STORAGE_BACKEND=file # Storage backend: file, memory, redis
NOETIC_UI_BUFFER_SIZE=1000     # WebSocket buffer size
```

#### Graceful Shutdown

The UI server handles shutdown signals properly:

```bash
# SIGINT (Ctrl+C) - Graceful shutdown with timeout
./noetic-ui serve
Ctrl+C
# → "Received SIGINT, starting graceful shutdown..."
# → "Timeout: 10000ms"
# → "Server stopped gracefully"

# SIGTERM (Docker stop, process manager)
kill -TERM <pid>
# → Same graceful shutdown sequence

# Force kill after timeout
# → "Shutdown timeout exceeded, forcing exit"
```

**Shutdown Process:**
1. Stop accepting new WebSocket connections
2. Stop accepting new HTTP requests
3. Wait for pending requests to complete (up to timeout)
4. Close all client connections gracefully
5. Persist any pending trace data
6. Exit cleanly

#### Full Config File

```json
{
  "wsPort": 3333,
  "apiPort": 3334,
  "host": "127.0.0.1",
  "shutdownTimeout": 10000,
  "storage": {
    "type": "file",
    "path": "./.noetic/ui/traces"
  },
  "breakpoints": {
    "pauseOnError": true,
    "pauseOnSpawn": false
  },
  "theme": "system",
  "shortcuts": {
    "pause": "F8",
    "stepOver": "F10",
    "stepInto": "F11",
    "stepOut": "Shift+F11"
  }
}
```

---

## Security Considerations

**Initial Implementation (v1):**

1. **Local Development Only** - Designed for single developer use on localhost
2. **No Production** - Never enable in production builds (complete disable by default)
3. **Localhost Binding** - Server binds to `127.0.0.1` only (no external access)
4. **Plain Text Storage** - Traces stored locally in plaintext (encryption not required for v1)
5. **No PII Redaction** - Automatic redaction deferred to future version
6. **No Authentication** - Single user, no auth required for initial implementation

**Security Hardening (Future):**

For multi-developer or shared environments, consider:

- **PII Detection** - Automatic detection and redaction of sensitive data (regex patterns for emails, phone numbers, API keys)
- **Field Exclusion** - Configurable patterns to exclude specific fields from traces
- **Encryption at Rest** - Encrypt stored traces with user-provided key
- **Authentication** - Basic auth or token-based access control
- **Audit Logging** - Track who accessed which traces and when

---

## Future Enhancements

1. **Edit and Replay** - Modify node inputs directly in the UI and execute from that point forward (creates new execution branch)
2. **Collaborative Debugging** - Multiple developers viewing same trace simultaneously
3. **Performance Profiling** - Visual flame charts for execution time analysis
4. **Custom Visualizers** - Plugin system for domain-specific node views
5. **Mobile App** - React Native companion for on-the-go monitoring
6. **Timeline Compression** - Compress stored traces to reduce disk usage
7. **Runtime Agent Discovery** - File watcher for automatic agent discovery as you edit code
8. **Execution Throttling** - Skip recording for very high-frequency executions (configurable steps/second threshold)
9. **SSE Alternative** - Evaluate Server-Sent Events as alternative to WebSockets for server→client streaming
10. **Large Trace Support** - Virtual scrolling, timeline aggregation/LOD, support for 10,000+ steps
11. **Extended Configuration** - Auto-open browser, storage backend selection, customizable keyboard shortcuts

---

## Open Questions

1. Should the UI be a separate process (current plan) or embeddable in the host app?
2. Real-time collaboration support needed for v1?
3. Should traces persist across UI server restarts?
