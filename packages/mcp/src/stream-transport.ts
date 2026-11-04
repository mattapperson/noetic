/**
 * MCP over a process someone else starts: `McpStdioServer.spawn` launches the
 * server where it must run (another machine, a container) and hands back its
 * stdio as a `ByteStream`; this carries newline-delimited JSON-RPC
 * over them, as the stdio transport does over a local subprocess.
 */

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ByteStream, Spawn, SpawnCommand } from '@noetic-tools/types';

//#region Public API

/** @public An MCP transport over a process `spawn` starts. Each `start()` spawns it once. */
export class SpawnedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private process?: ByteStream;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private readonly buffer = new ReadBuffer();
  private readonly encoder = new TextEncoder();
  private closed = false;

  constructor(
    private readonly spawn: Spawn,
    private readonly command: SpawnCommand,
  ) {}

  async start(): Promise<void> {
    this.process = await this.spawn(this.command);
    this.writer = this.process.writable.getWriter();
    void this.read(this.process.readable);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.writer) {
      throw new Error('the spawned MCP server is not started');
    }
    await this.writer.write(this.encoder.encode(serializeMessage(message)));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.writer?.close().catch(() => undefined);
    await this.process?.close();
    this.onclose?.();
  }

  /** Feeds stdout to the buffer and hands on each complete message; the end of stdout closes the transport. */
  private async read(output: ReadableStream<Uint8Array>): Promise<void> {
    const reader = output.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        this.buffer.append(Buffer.from(value));
        this.drain();
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
    await this.close();
  }

  private drain(): void {
    for (;;) {
      try {
        const message = this.buffer.readMessage();
        if (message === null) {
          return;
        }
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

//#endregion
