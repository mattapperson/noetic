/**
 * Inspector host: the one process `bun run inspect` starts.
 *
 * Owns everything that must outlive an agent-code revision:
 *   - the agent file (`.data/agent.ts`) Monaco edits, seeded from
 *     `agent/default-agent.ts` on first boot
 *   - the file watcher that restarts the agent child on change (300ms
 *     debounce; changes during a restart coalesce into one follow-up)
 *   - the agent child lifecycle (spawn → health poll → SIGTERM → SIGKILL)
 *   - the console buffer — every line of child stdout/stderr, kept here so
 *     output survives child crashes and restarts
 *   - a reverse proxy `/api/agent/*` → the child (503 while it's down)
 *   - the Next dev server, spawned alongside
 *
 *   GET/PUT /api/code        read/save the agent file
 *   GET     /api/types       the editor's virtual node_modules
 *   GET     /api/console     buffered agent-process output
 *   POST    /api/reset       wipe session + layer state, fresh child
 *   GET     /api/host/status current child state
 *   GET     /api/host/events child lifecycle + console SSE
 */

import { existsSync, mkdirSync, rmSync, watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Subprocess } from 'bun';
import { CORS_HEADERS, createSseHub, jsonResponse } from './sse-hub';
import { collectTypeLibs } from './type-libs';
import type { ChildState, ConsoleLine, HostEvent, HostFrame } from './wire-types';

//#region Config

const HOST_PORT = Number(process.env.INSPECTOR_PORT ?? 4700);
const CHILD_PORT = Number(process.env.INSPECTOR_CHILD_PORT ?? 4701);
const UI_PORT = Number(process.env.INSPECTOR_UI_PORT ?? 3900);
const THREAD_ID = process.env.INSPECTOR_THREAD_ID ?? 'inspector-main';

const PKG_DIR = path.resolve(import.meta.dir, '..');
const DATA_DIR = path.join(PKG_DIR, '.data');
const AGENT_FILE = path.join(DATA_DIR, 'agent.ts');
const DEFAULT_AGENT = path.join(PKG_DIR, 'agent', 'default-agent.ts');

const DEBOUNCE_MS = 3e2;
const HEALTH_TIMEOUT_MS = 1e4;
const SIGKILL_AFTER_MS = 3e3;
const STDERR_TAIL_CHARS = 4e3;
const MAX_CONSOLE_LINES = 1e3;

//#endregion

//#region Console buffer

interface ConsoleBuffer {
  push(stream: ConsoleLine['stream'], text: string): void;
  lines(): ConsoleLine[];
}

function createConsoleBuffer(publish: (frame: HostFrame) => void): ConsoleBuffer {
  const lines: ConsoleLine[] = [];
  let seq = 0;

  return {
    push(stream, text): void {
      seq += 1;
      const line: ConsoleLine = {
        seq,
        stream,
        text,
        at: Date.now(),
      };
      lines.push(line);
      if (lines.length > MAX_CONSOLE_LINES) {
        lines.splice(0, lines.length - MAX_CONSOLE_LINES);
      }
      publish({
        type: 'console_line',
        line,
      });
    },
    lines: () => [
      ...lines,
    ],
  };
}

//#endregion

//#region Child supervisor

interface Supervisor {
  status(): HostEvent;
  trigger(): void;
  /** Stop the child, wipe session history + durable layer state, respawn. */
  reset(): void;
  stop(): Promise<void>;
}

interface SupervisorOpts {
  publish(frame: HostFrame): void;
  console: ConsoleBuffer;
}

function createSupervisor(opts: SupervisorOpts): Supervisor {
  let child: Subprocess | undefined;
  let state: ChildState = 'starting';
  let revision = 0;
  let lastError: HostEvent['error'];
  let restarting = false;
  let pendingTrigger = false;
  let pendingWipe = false;

  function setState(next: ChildState, error?: HostEvent['error']): void {
    state = next;
    lastError = error;
    opts.publish(status());
  }

  function status(): HostEvent {
    return {
      type: 'child_status',
      child: state,
      revision,
      error: lastError,
    };
  }

  async function waitHealthy(proc: Subprocess): Promise<boolean> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        return false;
      }
      try {
        const res = await fetch(`http://localhost:${CHILD_PORT}/status`);
        if (res.ok) {
          return true;
        }
      } catch {
        // Not listening yet.
      }
      await Bun.sleep(200);
    }
    return false;
  }

  async function stopChild(): Promise<void> {
    if (!child || child.exitCode !== null) {
      child = undefined;
      return;
    }
    try {
      await fetch(`http://localhost:${CHILD_PORT}/abort`, {
        method: 'POST',
      });
    } catch {
      // Child may already be unresponsive.
    }
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child?.kill('SIGKILL'), SIGKILL_AFTER_MS);
    await child.exited;
    clearTimeout(killTimer);
    child = undefined;
  }

  /** Line-buffered pump of one child output stream into the console buffer
   *  (and this process's own stdio). `sink` collects stderr for the
   *  failed-boot error tail. */
  async function pumpOutput(
    stream: unknown,
    name: 'stdout' | 'stderr',
    sink?: string[],
  ): Promise<void> {
    if (!(stream instanceof ReadableStream)) {
      return;
    }
    const decoder = new TextDecoder();
    let carry = '';
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      sink?.push(text);
      (name === 'stderr' ? process.stderr : process.stdout).write(`[agent] ${text}`);
      carry += text;
      const parts = carry.split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) {
        if (line.length > 0) {
          opts.console.push(name, line);
        }
      }
    }
    if (carry.length > 0) {
      opts.console.push(name, carry);
    }
  }

  async function spawnChild(): Promise<void> {
    revision += 1;
    setState('starting');
    const stderrChunks: string[] = [];
    const proc = Bun.spawn(
      [
        'bun',
        path.join(import.meta.dir, 'child.ts'),
      ],
      {
        cwd: PKG_DIR,
        env: {
          ...process.env,
          INSPECTOR_AGENT_FILE: AGENT_FILE,
          INSPECTOR_DATA_DIR: DATA_DIR,
          INSPECTOR_THREAD_ID: THREAD_ID,
          INSPECTOR_CHILD_PORT: String(CHILD_PORT),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    child = proc;
    void pumpOutput(proc.stdout, 'stdout');
    void pumpOutput(proc.stderr, 'stderr', stderrChunks);
    const healthy = await waitHealthy(proc);
    if (healthy) {
      setState('ready');
      opts.console.push('info', `── agent started (revision ${revision}) ──`);
      return;
    }
    await stopChild();
    opts.console.push('info', '── agent failed to start ──');
    setState('error', {
      message: 'agent child failed to start — check the agent code',
      stderrTail: stderrChunks.join('').slice(-STDERR_TAIL_CHARS),
    });
  }

  function wipeData(): void {
    rmSync(path.join(DATA_DIR, 'sessions'), {
      recursive: true,
      force: true,
    });
    rmSync(path.join(DATA_DIR, 'storage'), {
      recursive: true,
      force: true,
    });
    opts.console.push('info', '── session reset: history and layer state wiped ──');
  }

  async function restart(): Promise<void> {
    if (restarting) {
      pendingTrigger = true;
      return;
    }
    restarting = true;
    try {
      do {
        pendingTrigger = false;
        setState('restarting');
        await stopChild();
        if (pendingWipe) {
          pendingWipe = false;
          wipeData();
        }
        await spawnChild();
        // A save that landed mid-restart coalesces into exactly one more pass.
      } while (pendingTrigger);
    } finally {
      restarting = false;
    }
  }

  void restart();

  return {
    status,
    trigger(): void {
      void restart();
    },
    reset(): void {
      pendingWipe = true;
      void restart();
    },
    async stop(): Promise<void> {
      await stopChild();
    },
  };
}

//#endregion

//#region Agent file

async function ensureAgentFile(): Promise<void> {
  mkdirSync(DATA_DIR, {
    recursive: true,
  });
  if (!existsSync(AGENT_FILE)) {
    await writeFile(AGENT_FILE, await readFile(DEFAULT_AGENT, 'utf8'));
  }
}

async function watchAgentFile(onChange: () => void): Promise<void> {
  // Restart only when the file's content actually changed — macOS FSEvents
  // can replay a just-completed write (e.g. the first-boot seed) right after
  // the watcher registers, and editors touch files without changing them.
  let lastHash = Bun.hash(await readFile(AGENT_FILE, 'utf8'));
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const fireIfChanged = async (): Promise<void> => {
    const hash = Bun.hash(await readFile(AGENT_FILE, 'utf8').catch(() => ''));
    if (hash === lastHash) {
      return;
    }
    lastHash = hash;
    onChange();
  };

  watch(DATA_DIR, (_event, filename) => {
    if (filename !== path.basename(AGENT_FILE)) {
      return;
    }
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => void fireIfChanged(), DEBOUNCE_MS);
  });
}

//#endregion

//#region Type libs

/** The editor's virtual node_modules — built once per host run (workspace
 *  source changes rarely enough that a restart is an acceptable refresh). */
let typeLibsCache: Record<string, string> | undefined;

function typeLibs(): Record<string, string> {
  typeLibsCache ??= collectTypeLibs(path.resolve(PKG_DIR, '..', '..'));
  return typeLibsCache;
}

//#endregion

//#region Proxy

async function proxyToChild(request: Request, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  const target = `http://localhost:${CHILD_PORT}${pathname}${url.search}`;
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    // Pass the body stream through untouched so SSE frames flow immediately.
    const headers = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch {
    return jsonResponse(
      {
        error: 'agent restarting',
      },
      503,
    );
  }
}

//#endregion

//#region Main

async function main(): Promise<void> {
  await ensureAgentFile();

  const hub = createSseHub();
  const consoleBuffer = createConsoleBuffer((frame) => hub.publish(frame));
  const supervisor = createSupervisor({
    publish: (frame) => hub.publish(frame),
    console: consoleBuffer,
  });
  await watchAgentFile(() => supervisor.trigger());

  let revision = 0;

  Bun.serve({
    port: HOST_PORT,
    idleTimeout: 240,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        });
      }

      if (url.pathname.startsWith('/api/agent/')) {
        return proxyToChild(request, url.pathname.slice('/api/agent'.length));
      }

      if (url.pathname === '/api/types') {
        return jsonResponse({
          files: typeLibs(),
        });
      }

      if (url.pathname === '/api/console') {
        return jsonResponse({
          lines: consoleBuffer.lines(),
        });
      }

      if (url.pathname === '/api/reset' && request.method === 'POST') {
        supervisor.reset();
        return jsonResponse(
          {
            resetting: true,
          },
          202,
        );
      }

      if (url.pathname === '/api/code' && request.method === 'GET') {
        return jsonResponse({
          source: await readFile(AGENT_FILE, 'utf8'),
          path: AGENT_FILE,
          revision,
        });
      }

      if (url.pathname === '/api/code' && request.method === 'PUT') {
        const body = await request.json();
        const source =
          typeof body === 'object' && body !== null && 'source' in body ? body.source : undefined;
        if (typeof source !== 'string') {
          return jsonResponse(
            {
              error: 'expected { source: string }',
            },
            400,
          );
        }
        await writeFile(AGENT_FILE, source);
        revision += 1;
        return jsonResponse({
          revision,
        });
      }

      if (url.pathname === '/api/host/status') {
        return jsonResponse(supervisor.status());
      }

      if (url.pathname === '/api/host/events') {
        return hub.response();
      }

      return jsonResponse(
        {
          error: 'not found',
        },
        404,
      );
    },
  });

  const ui = Bun.spawn(
    [
      'bun',
      'run',
      'dev',
    ],
    {
      cwd: PKG_DIR,
      env: {
        ...process.env,
        PORT: String(UI_PORT),
        NEXT_PUBLIC_INSPECTOR_HOST: `http://localhost:${HOST_PORT}`,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );

  const shutdown = async (): Promise<void> => {
    ui.kill();
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (!process.env.OPENROUTER_API_KEY && !process.env.NOETIC_API_KEY) {
    console.warn('⚠  OPENROUTER_API_KEY is not set — model calls will fail.');
  }
  console.log(`[inspector] host on http://localhost:${HOST_PORT}`);
  console.log(`[inspector] UI on http://localhost:${UI_PORT}`);
}

void main();

//#endregion
