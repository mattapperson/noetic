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

import type { AcpAgent, AcpTransport, AcpTransportFactory } from '@noetic-tools/types';
import { defineAcpAgent } from './define';
import type { AcpToolWiring } from './tool-bridge';
import {
  claudeToolWiring,
  codexToolWiring,
  opencodeToolWiring,
  sessionToolWiring,
} from './tool-wiring';

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
  /**
   * Whether the agent can take Noetic tools. Tools are served on this
   * machine's loopback interface, which an agent behind a custom `transport`
   * (a sandbox, a remote host) may not reach — so with a `transport` this
   * defaults to `false`; set `true` when the agent runs on this machine.
   */
  tools?: boolean;
}

function preset({
  agentId,
  base,
  opts = {},
  wiring,
}: {
  agentId: string;
  base: AcpProcessSpec;
  opts?: AcpPresetOptions;
  wiring?: AcpToolWiring;
}): AcpAgent {
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
  const servesTools = opts.tools ?? opts.transport === undefined;
  return defineAcpAgent({
    agentId,
    transport: opts.transport ?? lazyStdioTransport(agentId, spec),
    env: spec.env,
    tools: servesTools ? wiring : undefined,
  });
}

//#endregion

//#region Presets

/**
 * Claude Code via `@agentclientprotocol/claude-agent-acp`, the ACP bridge over
 * the Claude Agent SDK.
 * @public
 */
export function claudeCode(opts: AcpPresetOptions = {}): AcpAgent {
  return preset({
    agentId: 'claude-code',
    base: {
      command: 'npx',
      args: [
        '-y',
        '@agentclientprotocol/claude-agent-acp',
      ],
    },
    opts,
    wiring: claudeToolWiring,
  });
}

/**
 * OpenAI Codex via `@agentclientprotocol/codex-acp`.
 * @public
 */
export function codex(opts: AcpPresetOptions = {}): AcpAgent {
  return preset({
    agentId: 'codex',
    base: {
      command: 'npx',
      args: [
        '-y',
        '@agentclientprotocol/codex-acp',
      ],
    },
    opts,
    wiring: codexToolWiring,
  });
}

/**
 * Gemini CLI, which speaks ACP natively behind its experimental flag. It
 * cannot take Noetic tools yet: its permission requests for MCP tools carry
 * no field the bridge can recognize them by.
 * @public
 */
export function gemini(opts: AcpPresetOptions = {}): AcpAgent {
  return preset({
    agentId: 'gemini',
    base: {
      command: 'gemini',
      args: [
        '--experimental-acp',
      ],
    },
    opts,
  });
}

/**
 * opencode, which speaks ACP natively via its `opencode acp` command.
 * @public
 */
export function opencode(opts: AcpPresetOptions = {}): AcpAgent {
  return preset({
    agentId: 'opencode',
    base: {
      command: 'opencode',
      args: [
        'acp',
      ],
    },
    opts,
    wiring: opencodeToolWiring,
  });
}

/**
 * The pi coding agent, reached through the community `pi-acp` adapter — the
 * same adapter Zed's agent registry points at. pi itself has no native ACP
 * mode yet, so this preset depends on a third-party bridge; if it misbehaves,
 * the issue belongs there rather than in pi or here. `pi-acp` ignores the MCP
 * servers it is given, so this agent cannot take Noetic tools.
 * @public
 */
export function pi(opts: AcpPresetOptions = {}): AcpAgent {
  return preset({
    agentId: 'pi',
    base: {
      command: 'npx',
      args: [
        '-y',
        'pi-acp',
      ],
    },
    opts,
  });
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
  /** See {@link AcpPresetOptions.tools}. The bridge joins `session/new` with no agent-specific settings. */
  tools?: boolean;
}): AcpAgent {
  if (!opts.transport && !opts.command) {
    throw new TypeError(
      `customAcpAgent(${JSON.stringify(opts.agentId)}) requires either a 'command' to spawn or a 'transport'.`,
    );
  }
  return preset({
    agentId: opts.agentId,
    base: {
      command: opts.command ?? '',
      args: opts.args,
      env: opts.env,
    },
    opts: {
      transport: opts.transport,
      tools: opts.tools,
    },
    wiring: sessionToolWiring,
  });
}

//#endregion
