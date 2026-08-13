/**
 * Noetic's implementation of the ACP **Client** side.
 *
 * ACP inverts the usual control flow: rather than reaching for the machine
 * itself, the agent asks the client to read files, write files, and run
 * terminals. Serving those requests here means every file and
 * shell operation a sub-agent performs flows through Noetic's own
 * {@link FsAdapter} and {@link ShellAdapter} — the same sandboxing, virtual
 * filesystem, and audit path as first-party steps.
 *
 * Capabilities are advertised from what the host can actually back, narrowed by
 * the step's config. A withdrawn capability is answered with a JSON-RPC
 * method-not-found rather than silently doing the work anyway.
 */

import type { AcpClientHost } from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';
import { RequestError } from '@zed-industries/agent-client-protocol';
import type { AcpPermissionResolverOptions } from './permissions';
import { resolvePermission, selectPermissionOption } from './permissions';
import { TerminalRegistry } from './terminals';

//#region Capability advertisement

/** Build the `ClientCapabilities` sent during `initialize`. */
export function clientCapabilitiesFor(host: AcpClientHost): acp.ClientCapabilities {
  const config = host.capabilities;
  return {
    fs: {
      readTextFile: config?.readTextFile !== false,
      writeTextFile: config?.writeTextFile !== false,
    },
    terminal: config?.terminal !== false,
  };
}

//#endregion

//#region Helpers

/**
 * Apply ACP's `line` / `limit` window. Line numbers are 1-indexed per the
 * specification; `limit` counts lines, not bytes.
 */
export function sliceLines(content: string, line?: number | null, limit?: number | null): string {
  const start = typeof line === 'number' && line > 1 ? line - 1 : 0;
  const count = typeof limit === 'number' ? limit : undefined;
  if (start === 0 && count === undefined) {
    return content;
  }
  const lines = content.split('\n');
  const end = count === undefined ? lines.length : start + count;
  return lines.slice(start, end).join('\n');
}

/** Directory portion of an absolute POSIX path, or `undefined` at the root. */
function parentDir(path: string): string | undefined {
  const index = path.lastIndexOf('/');
  if (index <= 0) {
    return undefined;
  }
  return path.slice(0, index);
}

//#endregion

//#region Client

/** @public Options for {@link NoeticAcpClient}. */
export interface NoeticAcpClientOptions {
  /**
   * The live host. Held by reference, never copied: the runtime rebinds its
   * per-turn fields when a session is reused, and a copy would freeze every
   * later step to the policy of the step that opened the connection.
   */
  host: AcpClientHost;
  /**
   * Where `session/update` notifications go. Separate from the host so the
   * connection can fan them out to its own turn accumulator as well, without
   * having to wrap (and thereby copy) the host.
   */
  onNotify: (notification: acp.SessionNotification) => void;
}

/**
 * The `Client` handed to the ACP connection. One instance per connection; it
 * owns the terminal registry, so closing the connection kills every command the
 * agent started.
 * @public
 */
export class NoeticAcpClient implements acp.Client {
  private readonly host: AcpClientHost;
  private readonly onNotify: (notification: acp.SessionNotification) => void;
  private readonly terminals: TerminalRegistry;

  constructor(opts: NoeticAcpClientOptions) {
    this.host = opts.host;
    this.onNotify = opts.onNotify;
    this.terminals = new TerminalRegistry(opts.host.shell, opts.host.cwd);
  }

  /**
   * Read the permission tiers off the host at CALL time, never snapshot them.
   * A connection outlives the step that opened it, and the host is rebound
   * per turn — snapshotting would answer every later step with the first
   * step's policy.
   */
  private get permissions(): AcpPermissionResolverOptions {
    return {
      policy: this.host.permissions,
      steer: this.host.steerPermission,
      handler: this.host.onPermissionRequest,
    };
  }

  /** Release every terminal this connection created. */
  async dispose(): Promise<void> {
    await this.terminals.releaseAll();
  }

  //#region Baseline

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const outcome = await resolvePermission(params, this.permissions);
    return {
      outcome: selectPermissionOption(
        outcome,
        params.options,
        this.permissions.policy?.persist === true,
      ),
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.onNotify(params);
  }

  //#endregion

  //#region File system

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    this.assertCapability(this.host.capabilities?.readTextFile !== false, 'fs/read_text_file');
    const content = await this.host.fs.readFileText(params.path);
    return {
      content: sliceLines(content, params.line, params.limit),
    };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    this.assertCapability(this.host.capabilities?.writeTextFile !== false, 'fs/write_text_file');
    const dir = parentDir(params.path);
    if (dir) {
      await this.host.fs.mkdir(dir);
    }
    await this.host.fs.writeFile(params.path, params.content);
    return {};
  }

  //#endregion

  //#region Terminals

  async createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    this.assertTerminalCapability('terminal/create');
    return {
      terminalId: this.terminals.create({
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        env: params.env,
        outputByteLimit: params.outputByteLimit,
      }),
    };
  }

  async terminalOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    this.assertTerminalCapability('terminal/output');
    const snapshot = this.terminals.output(params.terminalId);
    if (!snapshot) {
      throw unknownTerminal(params.terminalId);
    }
    return {
      output: snapshot.output,
      truncated: snapshot.truncated,
      exitStatus: snapshot.exitStatus,
    };
  }

  async waitForTerminalExit(
    params: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    this.assertTerminalCapability('terminal/wait_for_exit');
    const status = await this.terminals.waitForExit(params.terminalId);
    if (!status) {
      throw unknownTerminal(params.terminalId);
    }
    return {
      exitCode: status.exitCode,
      signal: status.signal,
    };
  }

  async killTerminal(params: acp.KillTerminalCommandRequest): Promise<acp.KillTerminalResponse> {
    this.assertTerminalCapability('terminal/kill');
    const killed = await this.terminals.kill(params.terminalId);
    if (!killed) {
      throw unknownTerminal(params.terminalId);
    }
    return {};
  }

  async releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
    this.assertTerminalCapability('terminal/release');
    await this.terminals.release(params.terminalId);
    return {};
  }

  //#endregion

  //#region internals

  private assertTerminalCapability(method: string): void {
    this.assertCapability(this.host.capabilities?.terminal !== false, method);
  }

  /** A withdrawn capability must fail loudly, not quietly do the work anyway. */
  private assertCapability(enabled: boolean, method: string): void {
    if (!enabled) {
      throw RequestError.methodNotFound(method);
    }
  }

  //#endregion
}

function unknownTerminal(terminalId: string): RequestError {
  return RequestError.invalidParams({
    terminalId,
    reason: 'unknown terminal id',
  });
}

//#endregion
