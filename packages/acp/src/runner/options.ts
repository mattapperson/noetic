/**
 * What `noetic-acp serve`'s flags grant, and what a runner says about the
 * trust it places in whoever holds its token.
 */

import { PRESET_COMMANDS, PRESET_ENV } from '../agents';
import { piLauncherPath } from '../tool-wiring';
import type { AcpRunnerGrant } from './grants';
import type { AcpRunnerOptions } from './serve';

/**
 * The runner options `noetic-acp serve`'s flags stand for: `--agent` grants
 * a preset's command with its environment names, `--spawn` a command line
 * (split on spaces), and `--env` a name every grant may set. Without either
 * grant the runner starts anything.
 *
 * @throws Error for an unknown `--agent` or an empty `--spawn`.
 */
export function runnerOptions(values: {
  agent?: string;
  spawn?: string[];
  env?: string[];
  cwd?: string;
}): AcpRunnerOptions {
  const grants = [
    ...(values.agent === undefined
      ? []
      : [
          presetGrant(values.agent),
        ]),
    ...(values.spawn ?? []).map(commandGrant),
  ];
  if (grants.length === 0) {
    return {
      cwd: values.cwd,
    };
  }
  const extra = values.env ?? [];
  return {
    cwd: values.cwd,
    allow: grants.map((grant) => ({
      ...grant,
      env: [
        ...(grant.env ?? []),
        ...extra,
      ],
    })),
  };
}

function presetGrant(agent: string): AcpRunnerGrant {
  if (!isPreset(agent)) {
    throw new Error(`Unknown agent '${agent}'. Known: ${Object.keys(PRESET_COMMANDS).join(', ')}.`);
  }
  const fixedEnv = agent === 'pi' ? piCommands() : {};
  return {
    ...PRESET_COMMANDS[agent],
    env: PRESET_ENV[agent].filter((name) => !Object.hasOwn(fixedEnv, name)),
    fixedEnv,
  };
}

/**
 * pi-acp starts whatever `PI_ACP_PI_COMMAND` names, and the launcher whatever
 * `NOETIC_PI_COMMAND` does, so the runner names both itself: its own
 * launcher, and its own pi.
 */
function piCommands(): Record<string, string> {
  return {
    PI_ACP_PI_COMMAND: piLauncherPath(),
    NOETIC_PI_COMMAND: process.env.NOETIC_PI_COMMAND ?? 'pi',
  };
}

function isPreset(id: string): id is keyof typeof PRESET_COMMANDS {
  return Object.hasOwn(PRESET_COMMANDS, id);
}

function commandGrant(line: string): AcpRunnerGrant {
  const [command, ...args] = line.split(' ').filter((word) => word !== '');
  if (command === undefined) {
    throw new Error('--spawn needs a command.');
  }
  return {
    command,
    args,
  };
}

/** A runner does what whoever holds its token, or its stdio, asks of it. */
export function trustWarning(options: AcpRunnerOptions): string {
  const what = options.allow
    ? 'start the granted commands, with the granted environment names,'
    : 'start any command';
  return `noetic-acp: whoever holds this runner's token (or its stdio) can ${what} as this user, and reach what they can reach. Give it only to hosts you trust.`;
}
