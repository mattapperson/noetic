#!/usr/bin/env node
/**
 * `noetic-pi` — what `pi-acp` starts in place of `pi` (through
 * `PI_ACP_PI_COMMAND`) when a step gives pi tools: pi itself, with the
 * `pi-noetic-tools` extension added. pi-acp passes no extra arguments of its
 * own, so the extension rides in here.
 *
 * Node runs it as `.js` from the published package, and as `.ts` (type
 * stripping) in the workspace; the extension beside it has the same suffix.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suffix = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const extension = fileURLToPath(new URL(`./extension.${suffix}`, import.meta.url));
const pi = process.env.NOETIC_PI_COMMAND ?? 'pi';

const child = spawn(
  pi,
  [
    '--extension',
    extension,
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
  },
);
child.once('error', (error: Error) => {
  process.stderr.write(`noetic-pi: could not start '${pi}': ${error.message}\n`);
  process.exit(127);
});
for (const signal of [
  'SIGINT',
  'SIGTERM',
] as const) {
  process.on(signal, () => child.kill(signal));
}
child.once('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
