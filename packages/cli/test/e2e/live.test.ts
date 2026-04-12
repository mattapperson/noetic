import { expect, Shell, test } from '@microsoft/tui-test';
import { join } from 'node:path';

const cliPath = join(process.cwd(), 'src', 'cli', 'cli.ts');
const hasApiKey = Boolean(process.env.OPENROUTER_API_KEY);

test.use({
  shell: Shell.Bash,
  rows: 30,
  columns: 100,
  env: {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  },
  program: {
    file: 'bun',
    args: ['run', cliPath],
  },
});

test.when(hasApiKey, 'answers a simple live question', async ({ terminal }) => {
  terminal.submit('What is 2 + 2?');
  await expect(terminal.getByText('4')).toBeVisible({ timeout: 30000 });
});

// Note: Tool execution tests are currently disabled pending resolution of
// @openrouter/agent tool call response validation issues
test.skip('can answer using the filesystem tools', async ({ terminal }) => {
  terminal.submit('What file in this project defines the CLI entry point?');
  await expect(terminal.getByText(/cli\.ts/g)).toBeVisible({ timeout: 30000 });
});
