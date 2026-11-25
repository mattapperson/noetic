/**
 * The keeper's control lines. They share the host's socket with the agent's
 * ACP stream; a control line is a JSON object with a `keeper` key, which no
 * JSON-RPC message has.
 */

import { z } from 'zod';

//#region Schemas

/** @public Host → keeper. */
export const KeeperHostLineSchema = z.discriminatedUnion('keeper', [
  /** The first line on every connection. */
  z.object({
    keeper: z.literal('hello'),
    token: z.string(),
    whenHostExits: z.enum([
      'keep',
      'stop',
    ]),
  }),
  /**
   * Serve the bridge at `target` on a loopback port the keeper owns. The same
   * `path` again keeps the port and points it at the new target.
   */
  z.object({
    keeper: z.literal('reach'),
    id: z.string(),
    path: z.string().startsWith('/'),
    target: z.string().url(),
  }),
  /** Start the agent. */
  z.object({
    keeper: z.literal('launch'),
    id: z.string(),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    cwd: z.string().optional(),
  }),
  /** Stop the agent's process tree and exit. */
  z.object({
    keeper: z.literal('stop'),
  }),
]);

/** @public Keeper → host. */
export const KeeperLineSchema = z.discriminatedUnion('keeper', [
  z.object({
    keeper: z.literal('welcome'),
    agent: z.enum([
      'running',
      'none',
    ]),
  }),
  z.object({
    keeper: z.literal('reached'),
    id: z.string(),
    url: z.string().url(),
  }),
  z.object({
    keeper: z.literal('launched'),
    id: z.string(),
  }),
  z.object({
    keeper: z.literal('error'),
    id: z.string(),
    message: z.string(),
  }),
  /** The agent's stderr. */
  z.object({
    keeper: z.literal('stderr'),
    data: z.string(),
  }),
]);

/** @public What the keeper reads from its stdin when it starts. */
export const KeeperConfigSchema = z.object({
  /** Unix socket path or Windows named pipe the keeper listens on. */
  address: z.string(),
  token: z.string().min(16),
  /** Where the keeper logs, and the agent's stderr goes while no host is attached. */
  log: z.string(),
  /** How long the agent may run with no host attached; 0 = no limit. */
  detachedTimeoutMs: z.number().int().min(0),
});

/** @public */
export type KeeperHostLine = z.infer<typeof KeeperHostLineSchema>;
/** @public */
export type KeeperLine = z.infer<typeof KeeperLineSchema>;
/** @public */
export type KeeperConfig = z.infer<typeof KeeperConfigSchema>;

//#endregion

//#region Helpers

/** Whether a line is a keeper control line rather than a JSON-RPC message. */
export function isControlLine(line: string): boolean {
  return line.startsWith('{"keeper":');
}

/** Split a byte stream's text into lines, keeping the unterminated tail. */
export class LineSplitter {
  private carry = '';
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    this.carry += this.decoder.decode(chunk, {
      stream: true,
    });
    const lines = this.carry.split('\n');
    this.carry = lines.pop() ?? '';
    return lines.filter((line) => line.length > 0);
  }
}

//#endregion
