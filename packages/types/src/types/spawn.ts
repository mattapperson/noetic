/**
 * Starting a process somewhere and carrying its stdio back: how a stdio MCP
 * server that must run where an ACP agent runs is started, with noetic still
 * its MCP client. `@noetic-tools/acp` implements it (`spawnOn(machine)`,
 * `AcpAgent.spawn`); `@noetic-tools/mcp` takes it (`mcp({ command, spawn })`).
 * Neither package imports the other.
 */

/**
 * A duplex byte stream: a process's stdio, or a socket.
 * @public
 */
export interface ByteStream {
  /** Bytes arriving from the far end (a process's stdout). */
  readonly readable: ReadableStream<Uint8Array>;
  /** Bytes sent to the far end (a process's stdin). */
  readonly writable: WritableStream<Uint8Array>;
  /** Tear the stream down and release what holds it (process, socket, …). */
  close(): Promise<void>;
}

/** @public A process to start. */
export interface SpawnCommand {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  /**
   * Added to that machine's environment: for an agent (`AcpMachine.launch`)
   * all of it; for an MCP server (`AcpMachine.spawn`, a `Spawn`) only the MCP
   * SDK's default list (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`),
   * as the SDK starts a local server.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Working directory on that machine. */
  readonly cwd?: string;
}

/**
 * Starts a process and returns its stdio as a byte stream.
 * @public
 */
export type Spawn = (command: SpawnCommand) => Promise<ByteStream>;
