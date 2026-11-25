/**
 * A stand-in for a sandbox-wrapped agent: reports its argv, cwd and the
 * environment names it was given on stderr, then echoes stdin to stdout.
 */
process.stderr.write(
  `${JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    env: Object.keys(process.env).sort(),
    only: process.env.WRAP_ONLY,
  })}\n`,
);
process.stdin.pipe(process.stdout);
