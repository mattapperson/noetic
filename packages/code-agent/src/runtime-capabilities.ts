export type RuntimeKind = 'browser' | 'worker' | 'node' | 'bun' | 'unknown';

export interface RuntimeCapabilities {
  kind: RuntimeKind;
  processes: boolean;
  nodeFs: boolean;
  unixSockets: boolean;
  interactiveTerminal: boolean;
  browserAutomation: boolean;
  lsp: boolean;
}

export function detectRuntimeCapabilities(): RuntimeCapabilities {
  const g = globalThis as typeof globalThis & {
    Bun?: unknown;
    WorkerGlobalScope?: unknown;
    window?: unknown;
    process?: {
      versions?: {
        node?: string;
      };
    };
  };
  const isBun = g.Bun !== undefined;
  const isNode = !!g.process?.versions?.node;
  const isWorker =
    typeof g.WorkerGlobalScope === 'function' && globalThis instanceof g.WorkerGlobalScope;
  const isBrowser = typeof g.window !== 'undefined';
  const kind: RuntimeKind = isBun
    ? 'bun'
    : isNode
      ? 'node'
      : isWorker
        ? 'worker'
        : isBrowser
          ? 'browser'
          : 'unknown';
  const hasNodeRuntime = isNode || isBun;

  return {
    kind,
    processes: hasNodeRuntime,
    nodeFs: hasNodeRuntime,
    unixSockets: hasNodeRuntime,
    interactiveTerminal: hasNodeRuntime,
    browserAutomation: hasNodeRuntime,
    lsp: hasNodeRuntime,
  };
}

export function createUnsupportedResult<T>(
  toolName: string,
  build: (message: string) => T,
  capabilities: RuntimeCapabilities = detectRuntimeCapabilities(),
): T {
  const message = `${toolName} is not supported in ${capabilities.kind} runtime. Run it in a Node/Bun runtime or provide a runtime-compatible adapter/plugin.`;
  console.error(`[noetic/code-agent] ${message}`);
  return build(message);
}
