/**
 * Shared test scaffolding: an in-process ACP agent wired to a Noetic ACP client
 * through the loopback transport, plus in-memory fs/shell adapters.
 *
 * The agent side is a real `AgentSideConnection` from the protocol library, so
 * these tests exercise the actual JSON-RPC wire format in both directions
 * rather than a hand-rolled stand-in.
 */

import type {
  AcpAgentConnection,
  AcpClientHost,
  AcpPermissionHandler,
  AcpPermissionPolicy,
  AcpPermissionSteerer,
  AcpSessionNotification,
  FsAdapter,
  FsStats,
  ShellAdapter,
  ShellExecOptions,
  ShellExecResult,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';
import { AgentSideConnection, ndJsonStream } from '@zed-industries/agent-client-protocol';
import { openAcpConnection } from '../src/connection';
import { createAcpLoopbackPair } from '../src/transport-loopback';

//#region Adapters

/** @public A minimal in-memory filesystem covering what the ACP client uses. */
export class MemoryFs implements FsAdapter {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  async readFile(path: string): Promise<Buffer> {
    return Buffer.from(await this.readFileText(path), 'utf8');
  }

  async readFileText(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async writeFileBytes(path: string, content: Buffer): Promise<void> {
    this.files.set(path, content.toString('utf8'));
  }

  async appendFile(path: string, content: string): Promise<void> {
    this.files.set(path, `${this.files.get(path) ?? ''}${content}`);
  }

  async mkdir(dir: string): Promise<void> {
    this.dirs.add(dir);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = await this.readFileText(oldPath);
    this.files.delete(oldPath);
    this.files.set(newPath, content);
  }

  async rm(path: string): Promise<void> {
    this.files.delete(path);
  }

  async access(path: string): Promise<void> {
    await this.readFileText(path);
  }

  async lstat(path: string): Promise<FsStats> {
    return await this.stat(path);
  }

  async stat(path: string): Promise<FsStats> {
    const content = await this.readFileText(path);
    return frameworkCast<FsStats>({
      isFile: () => true,
      isDirectory: () => false,
      size: content.length,
      mtime: new Date(0),
    });
  }

  async readdir(): Promise<string[]> {
    return [
      ...this.files.keys(),
    ];
  }

  async realpath(path: string): Promise<string> {
    return path;
  }

  async copyFile(src: string, dest: string): Promise<void> {
    this.files.set(dest, await this.readFileText(src));
  }
}

/** @public Records shell invocations and replays scripted results. */
export class RecordingShell implements ShellAdapter {
  readonly calls: Array<{
    command: string;
    options: ShellExecOptions;
  }> = [];
  /** Per-command scripted behaviour, matched by exact command line. */
  readonly script = new Map<
    string,
    {
      stdout?: string;
      exitCode?: number;
      /** Resolve only when this promise settles, so cancellation can be tested. */
      hold?: Promise<void>;
    }
  >();

  async exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
    this.calls.push({
      command,
      options,
    });
    const scripted = this.script.get(command);
    if (scripted?.hold) {
      // Race the hold against cancellation so `kill()` is observable without
      // the test having to guess when the abort lands.
      await Promise.race([
        scripted.hold,
        abortSignalPromise(options.signal),
      ]);
    }
    if (options.signal?.aborted === true) {
      throw new Error('aborted');
    }
    const stdout = scripted?.stdout ?? '';
    if (stdout.length > 0) {
      options.onData?.(Buffer.from(stdout, 'utf8'));
    }
    return {
      stdout,
      stderr: '',
      exitCode: scripted?.exitCode ?? 0,
    };
  }
}

//#endregion

/** Resolves when the signal aborts; never resolves when there is no signal. */
function abortSignalPromise(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise<void>(() => undefined);
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), {
      once: true,
    });
  });
}

//#region Fake agent

/** Everything the fake agent should do during one prompt turn. */
export interface FakeAgentScript {
  /** Capabilities the agent advertises during `initialize`. */
  capabilities?: acp.AgentCapabilities;
  authMethods?: acp.AuthMethod[];
  /** Mode state returned from `session/new`. */
  modes?: acp.SessionModeState;
  models?: acp.SessionModelState;
  /** Stop reason returned from `session/prompt`. Defaults to `end_turn`. */
  stopReason?: acp.PromptResponse['stopReason'];
  /**
   * Driven on every prompt turn. Receives the live connection so it can push
   * `session/update` notifications and call back into the client.
   */
  onPrompt?: (
    conn: AgentSideConnection,
    params: acp.PromptRequest,
  ) => Promise<acp.PromptResponse['stopReason'] | undefined>;
}

/** Observable record of what the client asked the agent to do. */
export interface FakeAgentCalls {
  initialize: acp.InitializeRequest[];
  newSession: acp.NewSessionRequest[];
  loadSession: acp.LoadSessionRequest[];
  prompt: acp.PromptRequest[];
  cancel: acp.CancelNotification[];
  setMode: acp.SetSessionModeRequest[];
  setModel: acp.SetSessionModelRequest[];
  authenticate: acp.AuthenticateRequest[];
}

function emptyCalls(): FakeAgentCalls {
  return {
    initialize: [],
    newSession: [],
    loadSession: [],
    prompt: [],
    cancel: [],
    setMode: [],
    setModel: [],
    authenticate: [],
  };
}

/** @public A live ACP test rig: connected client + agent-side observations. */
export interface AcpTestRig {
  connection: AcpAgentConnection;
  /** The very host object handed to the connection — rebind it to simulate a step change. */
  host: AcpClientHost;
  calls: FakeAgentCalls;
  /** Every notification the host observed. */
  updates: AcpSessionNotification[];
  fs: MemoryFs;
  shell: RecordingShell;
  close(): Promise<void>;
}

/** @public Host overrides for {@link createAcpTestRig}. */
export interface AcpTestRigOptions {
  script?: FakeAgentScript;
  policy?: AcpPermissionPolicy;
  steer?: AcpPermissionSteerer;
  handler?: AcpPermissionHandler;
  capabilities?: AcpClientHost['capabilities'];
  fs?: MemoryFs;
  shell?: RecordingShell;
  cwd?: string;
  signal?: AbortSignal;
}

/**
 * Stand up a real ACP connection between a Noetic client and an in-process
 * agent. Nothing is mocked below the protocol layer.
 * @public
 */
export async function createAcpTestRig(opts: AcpTestRigOptions = {}): Promise<AcpTestRig> {
  const script = opts.script ?? {};
  const calls = emptyCalls();
  const updates: AcpSessionNotification[] = [];
  const fs = opts.fs ?? new MemoryFs();
  const shell = opts.shell ?? new RecordingShell();
  const cwd = opts.cwd ?? '/workspace';

  const pair = createAcpLoopbackPair();
  let sessionCounter = 0;

  const agentConnection = new AgentSideConnection(
    (conn) => ({
      async initialize(params) {
        calls.initialize.push(params);
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: script.capabilities ?? {},
          authMethods: script.authMethods ?? [],
        };
      },
      async newSession(params) {
        calls.newSession.push(params);
        sessionCounter += 1;
        return {
          sessionId: `session-${sessionCounter}`,
          modes: script.modes,
          models: script.models,
        };
      },
      async loadSession(params) {
        calls.loadSession.push(params);
        return {};
      },
      async authenticate(params) {
        calls.authenticate.push(params);
        return {};
      },
      async setSessionMode(params) {
        calls.setMode.push(params);
        return {};
      },
      async setSessionModel(params) {
        calls.setModel.push(params);
        return {};
      },
      async prompt(params) {
        calls.prompt.push(params);
        const stopReason = await script.onPrompt?.(conn, params);
        return {
          stopReason: stopReason ?? script.stopReason ?? 'end_turn',
        };
      },
      async cancel(params) {
        calls.cancel.push(params);
      },
    }),
    ndJsonStream(pair.agent.writable, pair.agent.readable),
  );
  // Referenced so the connection is not garbage-collected mid-test.
  void agentConnection;

  const host: AcpClientHost = {
    cwd,
    fs,
    shell,
    threadId: 'thread-test',
    signal: opts.signal,
    capabilities: opts.capabilities,
    permissions: opts.policy,
    steerPermission: opts.steer,
    onPermissionRequest: opts.handler,
    onSessionUpdate: (notification) => {
      updates.push(notification);
    },
  };

  const connection = await openAcpConnection({
    agentId: 'fake-agent',
    transport: pair.client,
    host,
    signal: opts.signal,
  });

  return {
    connection,
    host,
    calls,
    updates,
    fs,
    shell,
    async close() {
      await connection.close();
    },
  };
}

/** @public Build a text `session/update` notification. */
export function textChunk(
  sessionId: string,
  text: string,
  kind:
    | 'agent_message_chunk'
    | 'agent_thought_chunk'
    | 'user_message_chunk' = 'agent_message_chunk',
): acp.SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: kind,
      content: {
        type: 'text',
        text,
      },
    },
  };
}

//#endregion
