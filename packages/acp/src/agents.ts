/**
 * Presets for the coding agents that speak ACP today.
 *
 * A preset is only a launch recipe: which binary to run and with which flags.
 * There is no vendor SDK, no optional peer dependency, and no per-agent
 * protocol code — that is the whole point of standardising on ACP. Any agent
 * not listed here works through {@link customAcpAgent}.
 *
 * The stdio transport is reached through a dynamic `import()`, so this module
 * has no static `node:*` import and nothing loads `child_process` until a
 * connection is actually opened. Note that is a runtime property, not a
 * bundling one: the specifier is static, so a bundler still resolves and
 * includes `./stdio`. A browser build wanting it excluded should alias or
 * externalise `@noetic-tools/acp/stdio`.
 */

import type { AcpAgent, AcpApiKey, AcpTransport, AcpTransportFactory } from '@noetic-tools/types';
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
  /** Override where the agent reads an API key, e.g. a bridge reading a different variable. */
  apiKey?: AcpApiKey;
}

function preset(
  agentId: string,
  base: AcpProcessSpec & {
    apiKey?: AcpApiKey;
  },
  opts: AcpPresetOptions = {},
): AcpAgent {
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
    apiKey: opts.apiKey ?? base.apiKey,
  });
}

//#endregion

//#region Presets

/**
 * Claude Code via `@agentclientprotocol/claude-agent-acp`, the ACP bridge over the
 * Claude Agent SDK.
 * @public
 */
export function claudeCode(opts: AcpPresetOptions = {}): AcpAgent {
  return preset(
    'claude-code',
    {
      command: 'npx',
      args: [
        '-y',
        '@agentclientprotocol/claude-agent-acp',
      ],
      // The bridge reads the key itself; it advertises no API-key method.
      apiKey: {
        env: 'ANTHROPIC_API_KEY',
      },
    },
    opts,
  );
}

/**
 * OpenAI Codex via `@agentclientprotocol/codex-acp`.
 * @public
 */
export function codex(opts: AcpPresetOptions = {}): AcpAgent {
  return preset(
    'codex',
    {
      command: 'npx',
      args: [
        '-y',
        '@agentclientprotocol/codex-acp',
      ],
      apiKey: {
        env: 'CODEX_API_KEY',
        methodId: 'api-key',
      },
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
      apiKey: {
        env: 'GEMINI_API_KEY',
        methodId: 'gemini-api-key',
      },
    },
    opts,
  );
}

/**
 * opencode, which speaks ACP natively via its `opencode acp` command.
 * @public
 */
export function opencode(opts: AcpPresetOptions = {}): AcpAgent {
  return preset(
    'opencode',
    {
      command: 'opencode',
      args: [
        'acp',
      ],
    },
    opts,
  );
}

/**
 * The pi coding agent, reached through the community `pi-acp` adapter — the
 * same adapter Zed's agent registry points at. pi itself has no native ACP
 * mode yet, so this preset depends on a third-party bridge; if it misbehaves,
 * the issue belongs there rather than in pi or here.
 * @public
 */
export function pi(opts: AcpPresetOptions = {}): AcpAgent {
  return preset(
    'pi',
    {
      command: 'npx',
      args: [
        '-y',
        'pi-acp',
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
  /** Where the agent reads an API key, so a step can pass one with `auth.apiKey`. */
  apiKey?: AcpApiKey;
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
      apiKey: opts.apiKey,
    },
  );
}

//#endregion
