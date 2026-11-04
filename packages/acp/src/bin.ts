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
 * environment names plus every `--env` name, inside `--cwd`. For pi the
 * runner names pi's command itself. Whoever holds the token can start what
 * the grants allow, as the runner's user.
 */

import { parseArgs } from 'node:util';
import { runnerOptions, trustWarning } from './runner/options';
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
  process.stderr.write(`${trustWarning(options)}\n`);
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

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e));
});
