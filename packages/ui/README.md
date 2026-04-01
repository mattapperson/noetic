# @noetic/ui

Visual debugging interface for Noetic agent workflows. Provides real-time execution visualization, time-travel debugging, and interactive node graphs.

## Installation

### Option 1: Standalone Executable (Recommended)

Download a pre-built binary for your platform - **zero dependencies required**:

**macOS/Linux - One-line install:**
```bash
curl -fsSL https://raw.githubusercontent.com/mattapperson/noetic/main/packages/ui/scripts/install.sh | bash
```

**Windows - Download manually:**
Download `noetic-ui-windows-x64.exe` from [GitHub Releases](https://github.com/mattapperson/noetic/releases).

**Manual download for all platforms:**
Visit [GitHub Releases](https://github.com/mattapperson/noetic/releases) and download the appropriate binary for your platform:
- `noetic-ui-darwin-arm64` (Apple Silicon Macs)
- `noetic-ui-darwin-x64` (Intel Macs)
- `noetic-ui-linux-arm64` (ARM64 Linux)
- `noetic-ui-linux-x64` (x64 Linux)
- `noetic-ui-windows-x64.exe` (Windows)

Then run:
```bash
# macOS/Linux
chmod +x noetic-ui-darwin-arm64
./noetic-ui-darwin-arm64 serve

# Windows
noetic-ui-windows-x64.exe serve
```

### Option 2: Docker

```bash
docker run -p 3333:3333 -p 3334:3334 noetic/ui
```

### Option 3: Bun/NPX (Development)

For development or when you need the programmatic API:

```bash
# Requires Bun: https://bun.sh
bunx @noetic/ui serve

# Or install locally
bun add -D @noetic/ui
bunx noetic-ui serve
```

**Note:** The npm package requires Bun to run. If you don't have Bun installed, use the standalone executable (Option 1) instead.

## Quick Start

### Using Standalone Executable

```bash
# Start the UI server
noetic-ui serve

# Or with custom ports
NOETIC_UI_WS_PORT=3333 NOETIC_UI_API_PORT=3334 noetic-ui serve
```

### Connect Your Agent

Add the UI instrumentation to your agent:

```typescript
import { createDebugHarness } from '@noetic/ui/runtime';

const harness = createDebugHarness({
  name: 'my-agent',
  initialStep: myStep,
  // Optional: configure debugging
  debugger: {
    breakpoints: ['step-id'],     // Pause at specific steps
    pauseOnError: true,           // Auto-pause on errors
    autoStart: false,             // Wait for debugger to attach
  }
});

// Run with UI enabled
const result = await harness.execute('user input');
```

Or use the standard harness with trace export:

```typescript
import { AgentHarness } from '@noetic/core';
import { NoeticUITraceExporter } from '@noetic/ui/runtime';

const exporter = new NoeticUITraceExporter({ port: 3333 });

const harness = new AgentHarness({
  name: 'my-agent',
  initialStep: myStep,
  traceExporter: exporter,
});
```

### Enable UI Connection

Run your agent with the environment variable:

```bash
NOETIC_UI_ENABLED=true bun run your-agent.ts
```

Then open your browser to: **http://localhost:3334**

## Features

- **Real-time Execution Tracing** - Watch agents execute step-by-step with live updates
- **Interactive Node Graph** - Visualize agent execution flow with zoom, pan, and selection
- **Time-travel Debugging** - Scrub through execution history with the timeline
- **Step Inspector** - View detailed information about each step (LLM calls, tool invocations, state)
- **Breakpoint Support** - Pause execution at specific steps for debugging
- **Zero Production Impact** - Tree-shakeable, disabled by default, only connects when `NOETIC_UI_ENABLED=true`

## Architecture

The UI consists of three components:

1. **WebSocket Service** (port 3333) - Receives trace data from agents
2. **Next.js Dev UI** (port 3334) - Visual debugger interface
3. **Runtime Instrumentation** - TraceExporter that sends data to the service

```
┌─────────────┐      WebSocket       ┌──────────────┐      HTTP      ┌─────────────┐
│   Agent     │ ───────────────────► │  UI Service  │ ◄───────────── │  Browser    │
│  (runtime)  │   trace events       │   (3333)     │   (port 3334)  │  (Next.js)  │
└─────────────┘                      └──────────────┘                └─────────────┘
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NOETIC_UI_ENABLED` | `false` | Enable UI integration (required for connection) |
| `NOETIC_UI_WS_PORT` | `3333` | WebSocket server port |
| `NOETIC_UI_API_PORT` | `3334` | REST API/Web UI port |
| `NOETIC_UI_HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` for remote access) |
| `NOETIC_UI_STORAGE_PATH` | `.noetic/ui/traces` | Trace storage directory (relative to project root) |
| `NOETIC_UI_THEME` | `system` | UI theme: `system`, `dark`, `light` |
| `NOETIC_UI_SHUTDOWN_TIMEOUT` | `10000` | Graceful shutdown timeout in ms |

### Programmatic Configuration

```typescript
import { NoeticUIServerManager } from '@noetic/ui/service';

const server = new NoeticUIServerManager({
  wsPort: 3333,        // WebSocket port
  apiPort: 3334,       // REST API port
  host: '127.0.0.1',   // Bind address
  storagePath: './.noetic/ui/traces', // Trace storage location
});

await server.start();
```

### Trace Exporter Options

```typescript
import { NoeticUITraceExporter } from '@noetic/ui/runtime';

const exporter = new NoeticUITraceExporter({
  port: 3333,              // WebSocket service port
  host: 'localhost',        // WebSocket service host
  autoReconnect: true,      // Auto-reconnect on disconnect
  reconnectInterval: 1000,  // Reconnect interval in ms
  bufferSize: 1000,         // Max events to buffer when disconnected
});
```

## Development

### Prerequisites

- Bun 1.0+ (https://bun.sh)

### Setup

```bash
cd packages/ui
bun install
```

### Development Scripts

```bash
# Start development server (with hot reload)
bun run dev

# Start WebSocket service only
bun run serve

# Build Next.js static files
bun run build

# Build standalone executables for all platforms
bun run build:exe

# Type check
bun run typecheck

# Lint
bun run lint

# Format code
bun run format
```

### Building Executables

The standalone executables are built using Bun's native `--compile` feature:

```bash
# Build for all platforms (requires cross-compilation support)
bun run build:exe

# Or manually for current platform
bun build --compile --outfile noetic-ui src/service/index.ts
```

This creates a single binary (~50-110MB depending on platform) that includes:
- The complete WebSocket server
- REST API server
- Pre-built Next.js UI files
- All runtime dependencies
- Embedded Bun runtime

### Project Structure

```
packages/ui/
├── app/                    # Next.js app directory
│   ├── layout.tsx         # Root layout with theme
│   ├── page.tsx           # Main UI page
│   └── globals.css        # CSS variables & Tailwind
├── src/
│   ├── client/            # Client-side code
│   │   ├── components/    # React components
│   │   ├── stores/        # Zustand state stores
│   │   └── lib/           # Client utilities
│   ├── service/           # Service-side code
│   │   ├── websocket.ts   # WebSocket service
│   │   ├── storage.ts     # Trace persistence
│   │   └── api.ts         # REST API
│   ├── runtime/           # Agent instrumentation
│   │   ├── exporter.ts    # TraceExporter implementation
│   │   ├── debugger.ts    # Debug harness
│   │   └── hook.ts        # Execution hooks
│   └── shared/            # Shared types
│       └── protocol.ts    # WebSocket message types
├── bin/
│   └── noetic-ui.js      # CLI entry point
├── scripts/
│   ├── build-executables.js  # Cross-platform build script
│   └── install.sh           # Install script for users
└── .github/workflows/
    └── build-executables.yml # CI/CD for releases
```

## API Reference

### WebSocket Protocol

The UI uses a simple WebSocket protocol for real-time updates:

**Client → Server:**
- `ping` - Health check
- `execution.list` - List traces
- `execution.subscribe` - Subscribe to trace updates
- `node.stepOver`, `node.stepInto`, `node.stepOut` - Debug control

**Server → Client:**
- `pong` - Health response
- `execution.started` - New execution began
- `execution.updated` - Execution state changed
- `execution.completed` - Execution finished

### REST API

The service exposes REST endpoints following RESTful best practices with nested resource URLs:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Service health check |
| `GET` | `/api/agents` | List all registered agents |
| `DELETE` | `/api/agents/:agentId` | Delete an agent and all its runs |
| `GET` | `/api/agents/:agentId/runs` | List runs for an agent |
| `GET` | `/api/agents/:agentId/runs/:runId` | Get a specific run with full trace data |
| `DELETE` | `/api/agents/:agentId/runs/:runId` | Delete a specific run |
| `GET` | `/api/metrics` | Get storage metrics (total runs, size, per-agent stats) |

**Response Format:**
All endpoints return JSON with a standard wrapper:
```json
{
  "success": true,
  "data": { ... }
}
```

## Troubleshooting

### Port Already in Use

If ports 3333 or 3334 are in use:

```bash
# Find and kill processes
lsof -ti:3333 | xargs kill
lsof -ti:3334 | xargs kill
```

Or configure different ports:

```bash
NOETIC_UI_WS_PORT=3335 NOETIC_UI_API_PORT=3336 noetic-ui serve
```

### Connection Issues

If the UI doesn't show agent executions:

1. Verify the WebSocket service is running: `curl http://localhost:3334/api/agents`
2. Check `NOETIC_UI_ENABLED=true` is set in your agent environment
3. Ensure the agent is using the TraceExporter
4. Check browser console for WebSocket connection errors
5. Verify storage directory is writable: `.noetic/ui/traces/`

### "Could not find dist directory" Error

If you see this error in the service console:

**Cause:** The static UI files haven't been built (development from source only).

**Solution:**

```bash
cd packages/ui
bun run build
```

**For standalone executable users:** This shouldn't happen. If it does, the binary may be corrupted. Re-download from GitHub releases.

### Build Errors

If you see CSS import errors:

```
Cannot find module './globals.css'
```

Make sure `css.d.ts` is included in your `tsconfig.json`:

```json
{
  "include": ["css.d.ts", "next-env.d.ts"]
}
```

## Programmatic API

For library use within your applications:

```typescript
import { startNoeticUI, stopNoeticUI } from '@noetic/ui/service';

const manager = await startNoeticUI({
  wsPort: 3333,
  apiPort: 3334,
});

// Later...
await stopNoeticUI(manager);
```

**Note:** The programmatic API requires Bun or a TypeScript-compatible runtime.

## Security

- **Localhost only** - Binds to 127.0.0.1 by default
- **No production data** - Designed for local development only
- **User-controlled storage** - Traces stored locally in project directory, no auto-cleanup
- **1000-step limit** - Warns on large traces to prevent memory issues
- **Graceful shutdown** - Proper signal handling for clean exits

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

Requires WebSocket support and modern JavaScript features.

## Contributing

This package is part of the Noetic monorepo. See the main README for contribution guidelines.

## License

MIT - See LICENSE in repo root
