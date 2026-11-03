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

import type { AcpAgent, AcpMachineFactory, AcpTransportFactory } from '@noetic-tools/types';
import { defineAcpAgent } from './define';
import type { AcpToolWiring } from './tool-bridge';
import {
  claudeToolWiring,
  codexToolWiring,
  geminiToolWiring,
  opencodeToolWiring,
  piToolWiring,
  sessionToolWiring,
} from './tool-wiring';

/** @public How to launch an agent as a process. */
export interface AcpProcessSpec {
  command: string;
  args?: ReadonlyArray<string>;
  env?: Record<string, string | undefined>;
}

/**
 * The `pi-acp` the `pi()` preset runs. 0.0.34 waits for an `agent_settled`
 * event `@mariozechner/pi-coding-agent` 0.73.1 never sends, so every prompt
 * hangs; 0.0.32 works with it. pi 1.x (`@earendil-works/pi-coding-agent`) is
 * untested.
 */
const PI_ACP_VERSION = '0.0.32';

/**
 * The command each preset starts, by agent id. A remote runner started with
 * `--agent <id>` starts only that command.
 * @public
 */
export const PRESET_COMMANDS = {
  'claude-code': {
    command: 'npx',
    args: [
      '-y',
      '@agentclientprotocol/claude-agent-acp',
    ],
  },
  codex: {
    command: 'npx',
    args: [
      '-y',
      '@agentclientprotocol/codex-acp',
    ],
  },
  gemini: {
    command: 'gemini',
    args: [
      '--experimental-acp',
    ],
  },
  opencode: {
    command: 'opencode',
    args: [
      'acp',
    ],
  },
  pi: {
    command: 'npx',
    args: [
      '-y',
      `pi-acp@${PI_ACP_VERSION}`,
    ],
  },
} as const satisfies Record<string, AcpProcessSpec>;

/**
 * The environment names each preset's tool settings set on its agent. A
 * remote runner started with `--agent <id>` lets a host set these for that
 * preset's command, and no others.
 * @public
 */
export const PRESET_ENV = {
  'claude-code': [
    'MCP_TOOL_TIMEOUT',
    'MAX_MCP_OUTPUT_TOKENS',
  ],
  codex: [
    'CODEX_CONFIG',
  ],
  gemini: [
    'GEMINI_CLI_TRUST_WORKSPACE',
  ],
  opencode: [
    'OPENCODE_CONFIG_CONTENT',
  ],
  pi: [
    'PI_ACP_PI_COMMAND',
    'NOETIC_PI_COMMAND',
    'NOETIC_TOOLS_URL',
    'NOETIC_TOOLS_HEADERS',
  ],
} as const satisfies Record<keyof typeof PRESET_COMMANDS, ReadonlyArray<string>>;

//#region Shared options

/** @public Options common to every process-backed preset. */
export interface AcpPresetOptions {
  /** Override the executable (e.g. a locally built binary). */
  command?: string;
  /** Extra arguments appended after the preset's own. */
  args?: ReadonlyArray<string>;
  /** Environment overrides for the agent process — API keys, feature flags. */
  env?: Record<string, string | undefined>;
  /**
   * The machine the agent runs on — a remote runner, a sandbox — when it is
   * not this one. The preset's command runs there, with its tool settings.
   */
  machine?: AcpMachineFactory;
  /** Attach to an agent this package does not start, in place of the preset's command. */
  transport?: AcpTransportFactory;
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
  wiring: AcpToolWiring;
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
  return defineAcpAgent({
    agentId,
    ...(opts.transport
      ? {
          transport: opts.transport,
        }
      : {
          command: {
            command: spec.command,
            args: spec.args,
          },
          machine: opts.machine,
        }),
    env: spec.env,
    tools: wiring,
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
    base: PRESET_COMMANDS['claude-code'],
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
    base: PRESET_COMMANDS.codex,
    opts,
    wiring: codexToolWiring,
  });
}

/** @public Options for {@link gemini}. */
export interface GeminiOptions extends AcpPresetOptions {
  /**
   * Trust the session's folder for this process (`GEMINI_CLI_TRUST_WORKSPACE`).
   * Gemini starts no MCP server, so serves no Noetic tools, in a folder it does
   * not trust, and it has no way to trust one server alone: trusting the
   * folder also loads its own `.gemini/settings.json` (MCP servers, hooks,
   * tool commands), `GEMINI.md`, and `.env`. A step that gives the agent
   * tools without it fails with `ACP_AGENT_CANNOT_TAKE_TOOLS` before the agent
   * starts. Leave it off for a repository you did not write.
   */
  trustWorkspace?: boolean;
}

/**
 * Gemini CLI, which speaks ACP natively behind its experimental flag.
 * @public
 */
export function gemini(opts: GeminiOptions = {}): AcpAgent {
  const { trustWorkspace, ...rest } = opts;
  const agent = preset({
    agentId: 'gemini',
    base: trustWorkspace
      ? {
          ...PRESET_COMMANDS.gemini,
          env: {
            GEMINI_CLI_TRUST_WORKSPACE: 'true',
          },
        }
      : PRESET_COMMANDS.gemini,
    opts: rest,
    wiring: geminiToolWiring,
  });
  const trusted = trustWorkspace || rest.env?.GEMINI_CLI_TRUST_WORKSPACE === 'true';
  // An attached agent already refuses tools, for the transport's reason.
  if (trusted || agent.refusesTools) {
    return agent;
  }
  return {
    ...agent,
    refusesTools: UNTRUSTED_GEMINI,
  };
}

/**
 * Gemini would start without the bridge and serve the step none of its tools,
 * where `callModel` would offer them all.
 */
const UNTRUSTED_GEMINI = {
  code: 'ACP_AGENT_CANNOT_TAKE_TOOLS',
  reason:
    'Gemini CLI starts no MCP server, the tool bridge included, in a folder it does not trust, so the agent would run with none of the tools.',
  hint: "Pass `gemini({ trustWorkspace: true })` to trust the session's folder for the agent process. That also loads the folder's own `.gemini/settings.json`, `GEMINI.md` and `.env`, so do it only for a repository you wrote; otherwise leave `tools` off the step.",
} as const;

/**
 * opencode, which speaks ACP natively via its `opencode acp` command.
 * @public
 */
export function opencode(opts: AcpPresetOptions = {}): AcpAgent {
  return preset({
    agentId: 'opencode',
    base: PRESET_COMMANDS.opencode,
    opts,
    wiring: opencodeToolWiring,
  });
}

/**
 * The pi coding agent, reached through the community `pi-acp` adapter — the
 * same adapter Zed's agent registry points at. pi itself has no native ACP
 * mode yet, so this preset depends on a third-party bridge; if it misbehaves,
 * the issue belongs there rather than in pi or here. `pi-acp` drops the MCP
 * servers it is given, so Noetic tools reach pi as native pi tools through
 * the `pi-noetic-tools` extension (see {@link piToolWiring}). The preset pins
 * `pi-acp@0.0.32`, the newest that works with pi 0.73
 * (`@mariozechner/pi-coding-agent`); pass `command`/`args` to run another.
 * @public
 */
export function pi(opts: AcpPresetOptions = {}): AcpAgent {
  return preset({
    agentId: 'pi',
    base: PRESET_COMMANDS.pi,
    opts,
    wiring: piToolWiring,
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
  machine?: AcpMachineFactory;
  /** See {@link AcpPresetOptions.transport}. */
  transport?: AcpTransportFactory;
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
      machine: opts.machine,
      transport: opts.transport,
    },
    wiring: sessionToolWiring,
  });
}

//#endregion
