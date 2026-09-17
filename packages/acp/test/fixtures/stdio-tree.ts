import { spawnSync } from 'node:child_process';

if (process.argv[2] === 'child') {
  process.on('SIGTERM', () => {});
  process.stdout.write(`${process.pid}\n`);
  setInterval(() => {}, 1_000);
} else {
  process.stdout.write(`${process.pid}\n`);
  // The wrapper cannot run a JavaScript signal handler while spawnSync waits.
  spawnSync(
    process.execPath,
    [
      import.meta.filename,
      'child',
    ],
    {
      stdio: 'inherit',
    },
  );
}
