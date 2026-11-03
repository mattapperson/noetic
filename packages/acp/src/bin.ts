#!/usr/bin/env node
/**
 * `noetic-acp serve` — the remote runner, run on the machine an ACP agent
 * should run on. Hosts reach it with `webSocketMachine()` (listening) or
 * `commandMachine()` (`--stdio`, started by ssh or `docker exec -i`).
 *
 *   noetic-acp serve --stdio [--agent <id>] [--spawn <command>]... [--env <name>]...
 *                    [--cwd <dir>]
 *   noetic-acp serve [--host 127.0.0.1] [--port 0] [--agent <id>] [--spawn <command>]...
 *                    [--env <name>]... [--cwd <dir>] [--tls-cert <pem> --tls-key <pem>]
 *
 * The WebSocket token comes from NOETIC_ACP_RUNNER_TOKEN, or is made up and
 * printed to stderr. `--agent` and `--spawn` limit the runner to that preset's
 * command and those command lines (split on spaces), each with the preset's
 * environment names plus every `--env` name, inside `--cwd`.
 */

import { parseArgs } from 'node:util';
import { PRESET_COMMANDS, PRESET_ENV } from './agents';
import type { AcpRunnerGrant } from './runner/grants';
import type { AcpRunnerOptions } from './runner/serve';
import { listenAcpRunner, newRunnerToken, readPem, serveAcpRunnerOverStdio } from './runner/serve';

const USAGE =
  'usage: noetic-acp serve [--stdio] [--host <host>] [--port <port>] [--agent <id>] [--spawn <command>]... [--env <name>]... [--cwd <dir>] [--tls-cert <pem> --tls-key <pem>]';

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb !== 'serve') {
    fail(USAGE);
  }
  const { values } = parseArgs({
    args: [
      ...rest,
    ],
    options: {
      stdio: {
        type: 'boolean',
      },
      host: {
        type: 'string',
      },
      port: {
        type: 'string',
      },
      agent: {
        type: 'string',
      },
      spawn: {
        type: 'string',
        multiple: true,
      },
      env: {
        type: 'string',
        multiple: true,
      },
      cwd: {
        type: 'string',
      },
      'tls-cert': {
        type: 'string',
      },
      'tls-key': {
        type: 'string',
      },
    },
  });
  const options = runnerOptions(values);
  if (values.stdio) {
    await serveAcpRunnerOverStdio(options);
    return;
  }
  const token = process.env.NOETIC_ACP_RUNNER_TOKEN ?? newRunnerToken();
  const cert = values['tls-cert'];
  const key = values['tls-key'];
  if ((cert === undefined) !== (key === undefined)) {
    fail('--tls-cert and --tls-key go together.');
  }
  const listener = await listenAcpRunner({
    ...options,
    host: values.host,
    port: values.port === undefined ? undefined : Number(values.port),
    token,
    tls:
      cert && key
        ? {
            cert: readPem(cert),
            key: readPem(key),
          }
        : undefined,
  });
  process.stderr.write(`noetic-acp runner listening on ${listener.url}\n`);
  if (!process.env.NOETIC_ACP_RUNNER_TOKEN) {
    process.stderr.write(`token: ${token}\n`);
  }
}

function runnerOptions(values: {
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
    fail(`Unknown agent '${agent}'. Known: ${Object.keys(PRESET_COMMANDS).join(', ')}.`);
  }
  return {
    ...PRESET_COMMANDS[agent],
    env: PRESET_ENV[agent],
  };
}

function isPreset(id: string): id is keyof typeof PRESET_COMMANDS {
  return Object.hasOwn(PRESET_COMMANDS, id);
}

function commandGrant(line: string): AcpRunnerGrant {
  const [command, ...args] = line.split(' ').filter((word) => word !== '');
  if (command === undefined) {
    fail('--spawn needs a command.');
  }
  return {
    command,
    args,
  };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e));
});
