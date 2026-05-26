import { join } from 'node:path';
import { Shell, test } from '@microsoft/tui-test';

import { typeSlowly, waitForView } from './helpers.js';

const cliPath = join(process.cwd(), 'src', 'cli', 'cli.ts');

test.use({
  shell: Shell.Bash,
  rows: 30,
  columns: 100,
  env: {
    OPENROUTER_API_KEY: 'test-key',
  },
  program: {
    file: 'bun',
    args: [
      'run',
      cliPath,
      '--api-key',
      'test-key',
    ],
  },
});

test('shows the input prompt on startup', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
  await waitForView(terminal, 'anthropic/claude-sonnet-4');
});

test('accepts typed input without crashing immediately', async ({ terminal }) => {
  await typeSlowly(terminal, 'hello', 20);
  await waitForView(terminal, /llo|ello|hello/);
});
