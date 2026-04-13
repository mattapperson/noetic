import { join } from 'node:path';
import { Shell, test } from '@microsoft/tui-test';

import { typeSlowly, waitForView } from './helpers.js';

const cliPath = join(process.cwd(), 'src', 'cli', 'cli.ts');

test.use({
  shell: Shell.Bash,
  rows: 24,
  columns: 80,
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

test('handles rapid text entry', async ({ terminal }) => {
  await typeSlowly(terminal, 'rapid input sequence', 10);
  await waitForView(terminal, /input sequence|sequence/);
});

test('handles special characters without corrupting prompt state', async ({ terminal }) => {
  // Type text including special characters that might cause issues
  await typeSlowly(terminal, 'special test', 10);
  await waitForView(terminal, /special|test/);
});

test('handles terminal resize during interaction', async ({ terminal }) => {
  await typeSlowly(terminal, 'resize-check', 10);
  terminal.resize(40, 10);
  terminal.resize(120, 40);
  await waitForView(terminal, /resize-check|ize-check/);
});

test('handles ctrl-c without crashing terminal shell', async ({ terminal }) => {
  terminal.keyCtrlC();
  await waitForView(terminal, 'Type a message...');
});
