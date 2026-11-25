/**
 * The keeper's entry point: read its config from stdin, listen, say `ready`
 * on stdout, then let go of both — the host that started it may go away
 * while the keeper runs on.
 */

import { stdin, stdout } from 'node:process';
import { runKeeper } from './process';
import { KeeperConfigSchema, LineSplitter } from './protocol';

async function readConfig(): Promise<unknown> {
  const splitter = new LineSplitter();
  for await (const chunk of stdin) {
    const [first] = splitter.push(chunk);
    if (first !== undefined) {
      return JSON.parse(first);
    }
  }
  throw new Error('The keeper got no config.');
}

async function main(): Promise<void> {
  const config = KeeperConfigSchema.parse(await readConfig());
  const { stopped } = await runKeeper(config);
  stdout.write('{"ready":true}\n');
  stdin.destroy();
  stdout.end();
  await stopped;
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `noetic acp keeper: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
