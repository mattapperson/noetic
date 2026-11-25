/**
 * A wrapper/child process tree for the stdio lifetime tests, shaped like the
 * Node launchers ACP bridges ship: the wrapper `spawnSync`s the real agent
 * with inherited stdio and so cannot run a JavaScript signal handler while it
 * waits. The child ignores SIGTERM, so only SIGKILL stops it. Each process
 * prints its pid on its own line.
 */
import { spawnSync } from 'node:child_process';

if (process.argv[2] === 'child') {
  if (process.argv[3] === 'stubborn') {
    process.on('SIGTERM', () => undefined);
  }
  process.stdout.write(`${process.pid}\n`);
  setInterval(() => undefined, 1e3);
} else {
  process.stdout.write(`${process.pid}\n`);
  spawnSync(
    process.execPath,
    [
      import.meta.filename,
      'child',
      process.argv[2] ?? '',
    ],
    {
      stdio: 'inherit',
    },
  );
}
