import { join } from 'node:path';
import { Shell, test } from '@microsoft/tui-test';

import { waitForAbsence, waitForView } from './helpers.js';

const cliPath = join(process.cwd(), 'src', 'cli', 'cli.ts');

test.use({
  shell: Shell.Bash,
  rows: 30,
  columns: 100,
  env: {
    OPENROUTER_API_KEY: 'test-key',
    HOME: '/tmp',
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

test('Ctrl+O opens the transcript overlay with the transcript hint', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
  terminal.write('\x0f');
  await waitForView(terminal, 'Transcript');
  await waitForView(terminal, 'press ctrl+o or Esc to close');
});

test('Ctrl+R opens the request items overlay with the request hint', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
  terminal.write('\x12');
  await waitForView(terminal, 'Request Items');
  await waitForView(terminal, 'press ctrl+r or Esc to close');
});

test('Ctrl+R while transcript is open swaps to the request view', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
  terminal.write('\x0f');
  await waitForView(terminal, 'Transcript');
  terminal.write('\x12');
  await waitForView(terminal, 'Request Items');
  await waitForAbsence(terminal, 'press ctrl+o or Esc to close');
});

test('Esc closes whichever overlay is open', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
  terminal.write('\x12');
  await waitForView(terminal, 'Request Items');
  terminal.write('\x1b');
  await waitForAbsence(terminal, 'Request Items');
});

test('Ctrl+O a second time closes the transcript overlay', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
  terminal.write('\x0f');
  await waitForView(terminal, 'Transcript');
  terminal.write('\x0f');
  await waitForAbsence(terminal, 'Transcript');
});

test('Ctrl+R a second time closes the request items overlay', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
  terminal.write('\x12');
  await waitForView(terminal, 'Request Items');
  terminal.write('\x12');
  await waitForAbsence(terminal, 'Request Items');
});
