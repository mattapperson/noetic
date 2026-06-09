/**
 * Stderr-routed logging helpers.
 *
 * The CLI renders the conversation via Ink, which owns stdout. Writing through
 * `console.log` / `console.warn` interleaves with the rendered TUI and breaks
 * its layout. These helpers route to `process.stderr` instead, matching the
 * existing pattern in `src/cli/cli.ts`. Replace with a real logger once one
 * exists.
 */

function format(level: 'warn' | 'error', message: string): string {
  return `[${level}] ${message}\n`;
}

export function warn(message: string): void {
  process.stderr.write(format('warn', message));
}

export function error(message: string): void {
  process.stderr.write(format('error', message));
}
