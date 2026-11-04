/**
 * Per-agent settings that make bridged tools reach the agent's model exactly
 * as they reach a `callModel` model: listed up front, output uncut, no extra
 * approval step, and no timeout a model-driven call would not have.
 */

import type { AcpMcpServer } from '@noetic-tools/types';
import { z } from 'zod';
import type { AcpToolWiring, ToolBridgeLaunch } from './tool-bridge';
import {
  claudeBridgedPermission,
  codexBridgedPermission,
  geminiBridgedPermission,
} from './tool-permissions';

const JsonObjectSchema = z.record(z.string(), z.unknown());

//#region Helpers

/** Largest timeout Node timers accept, in milliseconds. */
const NO_TIMEOUT_MS = 2147483647;
const NO_TIMEOUT_SEC = Math.floor(NO_TIMEOUT_MS / 1e3);
const UNBOUNDED = 1e9;

function hostEnv(name: string): string | undefined {
  const env: Record<string, string | undefined> | undefined = Reflect.get(
    globalThis,
    'process',
  )?.env;
  return env?.[name];
}

/** The JSON config an agent already has in `name`, from the preset or the host. */
function baseJsonConfig(launch: ToolBridgeLaunch, name: string): Record<string, unknown> {
  const raw = launch.env[name] ?? hostEnv(name);
  if (!raw) {
    return {};
  }
  const parsed = JsonObjectSchema.safeParse(parseJson(raw));
  if (!parsed.success) {
    throw new TypeError(`${name} must hold a JSON object.`);
  }
  return parsed.data;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function recordAt(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const parsed = JsonObjectSchema.safeParse(config[key]);
  return parsed.success ? parsed.data : {};
}

function pairsToRecord(
  pairs: ReadonlyArray<{
    name: string;
    value: string;
  }>,
): Record<string, string> {
  return Object.fromEntries(
    pairs.map((pair) => [
      pair.name,
      pair.value,
    ]),
  );
}

//#endregion

//#region Codex

/** A user's ACP MCP server as a Codex `mcp_servers` entry. SSE is refused later by the capability check. */
function codexServer(server: AcpMcpServer): Record<string, unknown> | undefined {
  if (!('type' in server)) {
    return {
      command: server.command,
      args: server.args,
      env: pairsToRecord(server.env),
    };
  }
  if (server.type === 'http') {
    return {
      url: server.url,
      http_headers: pairsToRecord(server.headers),
    };
  }
  return undefined;
}

/**
 * codex-acp replaces `CODEX_CONFIG.mcp_servers` with the servers in
 * `session/new`, and builds those from address fields only. So every server —
 * the bridge with its settings, and the user's own — is declared here, and
 * `session/new` carries none.
 */
export const codexToolWiring: AcpToolWiring = {
  declare: 'launch',
  permits: codexBridgedPermission,
  launchEnv(launch) {
    const config = baseJsonConfig(launch, 'CODEX_CONFIG');
    const servers = recordAt(config, 'mcp_servers');
    for (const server of launch.mcpServers) {
      const entry = codexServer(server);
      if (entry) {
        servers[server.name] = entry;
      }
    }
    servers[launch.bridge.serverName] = {
      url: launch.bridge.url,
      http_headers: pairsToRecord(launch.bridge.headers),
      // Codex otherwise reaches MCP tools only from model-written code.
      omit_tools_from: [
        'code_mode',
        'deferred',
      ],
      // Codex otherwise runs its own "Guardian Review" before each call.
      default_tools_approval_mode: 'approve',
      tool_timeout_sec: NO_TIMEOUT_SEC,
      tools: Object.fromEntries(
        launch.tools.map((tool) => [
          tool.name,
          {
            output_token_limit: UNBOUNDED,
          },
        ]),
      ),
    };
    // The config holds the bridge token and the user's server env; keep it out
    // of the environment of every command Codex runs.
    const shellPolicy = recordAt(config, 'shell_environment_policy');
    const excluded = Array.isArray(shellPolicy.exclude) ? shellPolicy.exclude : [];
    return {
      CODEX_CONFIG: JSON.stringify({
        ...config,
        mcp_servers: servers,
        shell_environment_policy: {
          ...shellPolicy,
          exclude: [
            ...excluded,
            'CODEX_CONFIG',
          ],
        },
      }),
    };
  },
};

//#endregion

//#region Others

/**
 * Claude Code reads its per-tool hints from the tool listing; the call
 * timeout and its MCP output token cap are set here.
 */
export const claudeToolWiring: AcpToolWiring = {
  declare: 'session',
  permits: claudeBridgedPermission,
  launchEnv(launch) {
    const setting = (name: string, value: number): string =>
      launch.env[name] ?? hostEnv(name) ?? String(value);
    return {
      MCP_TOOL_TIMEOUT: setting('MCP_TOOL_TIMEOUT', NO_TIMEOUT_MS),
      MAX_MCP_OUTPUT_TOKENS: setting('MAX_MCP_OUTPUT_TOKENS', UNBOUNDED),
    };
  },
};

/** opencode otherwise cuts tool output at 50 KiB and saves the rest to a file. */
export const opencodeToolWiring: AcpToolWiring = {
  declare: 'session',
  launchEnv(launch) {
    const config = baseJsonConfig(launch, 'OPENCODE_CONFIG_CONTENT');
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        tool_output: {
          max_lines: UNBOUNDED,
          max_bytes: UNBOUNDED,
        },
      }),
    };
  },
};

/**
 * Gemini CLI lists tools up front and returns output whole as is. It starts
 * the bridge only in a folder it trusts, which is the user's call to make
 * (`gemini({ trustWorkspace })`), never the wiring's.
 */
export const geminiToolWiring: AcpToolWiring = {
  declare: 'session',
  permits: geminiBridgedPermission,
};

/**
 * pi has no MCP client, and pi-acp drops the MCP servers it is given. So the
 * bridge is declared at launch: pi-acp starts the `noetic-pi` launcher in
 * place of `pi` (`PI_ACP_PI_COMMAND`), which adds the `pi-noetic-tools`
 * extension. The extension registers each bridged tool as a native pi tool —
 * same name, description and schema — and pi cuts no extension tool's result.
 * A `PI_ACP_PI_COMMAND` the host already set is the pi the launcher starts.
 */
export const piToolWiring: AcpToolWiring = {
  declare: 'launch',
  launchEnv(launch) {
    if (launch.mcpServers.length > 0) {
      throw new TypeError(
        'pi takes no MCP servers of its own: pi-acp drops them. Give their tools to the step as `tools` instead.',
      );
    }
    const pi = launch.env.PI_ACP_PI_COMMAND ?? hostEnv('PI_ACP_PI_COMMAND') ?? 'pi';
    return {
      PI_ACP_PI_COMMAND:
        launch.env.NOETIC_PI_LAUNCHER ?? hostEnv('NOETIC_PI_LAUNCHER') ?? piLauncherPath(),
      NOETIC_PI_COMMAND: launch.env.NOETIC_PI_COMMAND ?? hostEnv('NOETIC_PI_COMMAND') ?? pi,
      NOETIC_TOOLS_URL: launch.bridge.url,
      NOETIC_TOOLS_HEADERS: JSON.stringify(launch.bridge.headers),
    };
  },
};

/**
 * The launcher shipped beside this module. A runner started with
 * `--agent pi` names its own in place of the one a host sends.
 */
export function piLauncherPath(): string {
  const suffix = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return decodeURIComponent(new URL(`./pi/launch.${suffix}`, import.meta.url).pathname);
}

/**
 * Any agent that takes MCP servers in `session/new` and needs no settings.
 * It has no way to recognize the agent's permission requests for bridged
 * tools, so those go to the step's policy.
 */
export const sessionToolWiring: AcpToolWiring = {
  declare: 'session',
};

//#endregion
