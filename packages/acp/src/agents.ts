/**
 * Presets for the coding agents that speak ACP today.
 *
 * A preset is only a launch recipe: which binary to run and with which flags.
 * There is no vendor SDK, no optional peer dependency, and no per-agent
 * protocol code — that is the whole point of standardising on ACP. Any agent
 * not listed here works through {@link customAcpAgent}.
 *
 * The stdio transport is loaded through a lazy dynamic import so this module
 * stays free of `node:*` and the package's main entry remains runtime-neutral.
 */

import type { AcpAgent, AcpTransport, AcpTransportFactory } from '@noetic-tools/types';
import { defineAcpAgent } from './define';

//#region Lazy stdio

/** @public How to launch an agent as a local child process. */
export interface AcpProcessSpec {
  command: string;
  args?: ReadonlyArray<string>;
  env?: Record<string, string | undefined>;
}

/**
 * Defer the `node:child_process` import until a connection is actually opened,
 * so importing `@noetic-tools/acp` in a browser or worker stays safe.
 */
function lazyStdioTransport(agentId: string, spec: AcpProcessSpec): AcpTransportFactory {
  return async (opts): Promise<AcpTransport> => {
    const { stdioAcpTransport } = await import('./stdio');
    return await stdioAcpTransport({
      agentId,
      command: spec.command,
      args: spec.args,
      env: spec.env,
    })(opts);
  };
}

//#endregion

//#region Shared options

/** @public Options common to every process-backed preset. */
export interface AcpPresetOptions {
  /** Override the executable (e.g. a locally built binary). */
  command?: string;
  /** Extra arguments appended after the preset's own. */
  args?: ReadonlyArray<string>;
  /** Environment overrides for the agent process — API keys, feature flags. */
  env?: Record<string, string | undefined>;
  /** Supply a non-stdio transport (remote agent, test loopback, sandbox bridge). */
  transport?: AcpTransportFactory;
}

function preset(agentId: string, base: AcpProcessSpec, opts: AcpPresetOptions = {}): AcpAgent {
  const spec: AcpProcessSpec = {
    command: opts.command ?? base.command,
    args: [
      ...(base.args ?? []),
      ...(opts.args ?? []),
    ],
    env: {
      ...base.env,
      ...opts.env,
    },
  };
  return defineAcpAgent({
    agentId,
    transport: opts.transport ?? lazyStdioTransport(agentId, spec),
    env: spec.env,
  });
}

//#endregion

//#region Presets

/**
 * Claude Code via `@zed-industries/claude-code-acp`, the ACP bridge over the
 * Claude Code SDK.
 * @public
 */
export function claudeCode(opts: AcpPresetOptions = {}): AcpAgent {
  return preset(
    'claude-code',
    {
      command: 'npx',
      args: [
        '-y',
        '@zed-industries/claude-code-acp',
      ],
    },
    opts,
  );
}

/**
 * OpenAI Codex via `@zed-industries/codex-acp`.
 * @public
 */
export function codex(opts: AcpPresetOptions = {}): AcpAgent {
  return preset(
    'codex',
    {
      command: 'npx',
      args: [
        '-y',
        '@zed-industries/codex-acp',
      ],
    },
    opts,
  );
}

/**
 * Gemini CLI, which speaks ACP natively behind its experimental flag.
 * @public
 */
export function gemini(opts: AcpPresetOptions = {}): AcpAgent {
  return preset(
    'gemini',
    {
      command: 'gemini',
      args: [
        '--experimental-acp',
      ],
    },
    opts,
  );
}

/**
 * Any other ACP-speaking agent. Because the protocol is uniform, this is a
 * first-class way to use an agent — not a fallback.
 * @public
 */
export function customAcpAgent(opts: {
  agentId: string;
  command?: string;
  args?: ReadonlyArray<string>;
  env?: Record<string, string | undefined>;
  transport?: AcpTransportFactory;
}): AcpAgent {
  if (!opts.transport && !opts.command) {
    throw new TypeError(
      `customAcpAgent(${JSON.stringify(opts.agentId)}) requires either a 'command' to spawn or a 'transport'.`,
    );
  }
  return preset(
    opts.agentId,
    {
      command: opts.command ?? '',
      args: opts.args,
      env: opts.env,
    },
    {
      transport: opts.transport,
    },
  );
}

//#endregion
