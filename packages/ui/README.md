# @noetic/ui

Visual debugging interface for Noetic agent workflows. Provides real-time execution visualization, time-travel debugging, and interactive node graphs.

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

## Quick Start

### Option 1: Using from NPM (Recommended for Users)

Install the package in your project:

```bash
npm install @noetic/ui
# or
bun add @noetic/ui
```

**Start the WebSocket service:**

```bash
# Use the installed CLI
npx @noetic/ui serve

# Or with Bun
bunx @noetic/ui serve
```

The service will start on port 3333 and automatically serve the built UI from the package. Open http://localhost:3334 in your browser.

**Note:** The npm package includes pre-built static files. If you're installing from Git/source, you must build first (see Option 2).

### Option 2: Development from Source (For Contributors)

Clone the repository and install dependencies:

```bash
cd packages/ui
bun install
```

**Important: Build the static UI files first:**

```bash
bun run build
```

This creates the `dist/` folder with the compiled Next.js static files. The service requires these files to serve the web UI.

**Start the WebSocket service:**

```bash
# From repo root
bun run dev:ui

# Or from packages/ui
bun run serve
```

**Start the dev UI (for development with hot reload):**

```bash
cd packages/ui
bun run dev
```

The UI will be available at http://localhost:3334

### 3. Connect Your Agent

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

### 4. Enable UI Connection

Run your agent with the environment variable:

```bash
NOETIC_UI_ENABLED=true bun run your-agent.ts
```

## Configuration

### UI Service Options

```typescript
import { NoeticUIServerManager } from '@noetic/ui/service';

const server = new NoeticUIServerManager({
  wsPort: 3333,        // WebSocket port
  apiPort: 3334,       // REST API port
  host: '127.0.0.1',   // Bind address
  storagePath: './.noetic-ui-storage', // Trace storage location
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

## Development Scripts

```bash
# Start dev UI only (client)
bun run dev

# Start WebSocket service only
bun run serve

# Build for static export
bun run build

# Type check
bun run typecheck

# Lint
bun run lint

# Format code
bun run format
```

## Project Structure

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
├── css.d.ts               # CSS type declarations
└── next-env.d.ts          # Next.js types
```

## Using with Different Package Managers

### With Bun (recommended)

```bash
cd packages/ui
bun install
bun run dev
```

### With npm/pnpm

The UI works with npm and pnpm as well:

```bash
cd packages/ui
npm install
npm run dev
```

Note: You may see "Failed to patch lockfile" warnings in workspace environments. These are harmless - the SWC binary is already installed and the dev server works correctly.

## Troubleshooting

### Port Already in Use

If ports 3333 or 3334 are in use:

```bash
# Find and kill processes
lsof -ti:3333 | xargs kill
lsof -ti:3334 | xargs kill
```

Or configure different ports:

```typescript
const server = new NoeticUIServerManager({
  wsPort: 3335,
  apiPort: 3336,
});
```

### Connection Issues

If the UI doesn't show agent executions:

1. Verify the WebSocket service is running: `curl http://localhost:3333/health`
2. Check `NOETIC_UI_ENABLED=true` is set
3. Ensure the agent is using the TraceExporter
4. Check browser console for WebSocket connection errors

### "Could not find dist directory" Error

If you see this error in the service console or get `{"success":false,"error":"Not found"}` in the browser:

**Cause:** The static UI files haven't been built.

**Solution:**

```bash
cd packages/ui
bun run build
```

This creates the `dist/` folder with compiled Next.js static files that the service serves. 

**For published package users:** This shouldn't happen with npm installs. If it does, the package may not have been built before publishing. Use the development setup above or report an issue.

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

The service also exposes REST endpoints:

- `GET /health` - Service health check
- `GET /api/agents` - List registered agents
- `GET /api/executions` - List executions
- `GET /api/executions/:id` - Get execution details
- `GET /api/executions/:id/traces` - Get trace data

## Security

- **Localhost only** - Binds to 127.0.0.1 by default
- **No production data** - Designed for local development only
- **User-controlled storage** - Traces stored locally, no auto-cleanup
- **1000-step limit** - Warns on large traces to prevent memory issues

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

Requires WebSocket support and modern JavaScript features.

## Contributing

This package is part of the Noetic monorepo. See the main README for contribution guidelines.

## License

MIT - See LICENSE in repo root
