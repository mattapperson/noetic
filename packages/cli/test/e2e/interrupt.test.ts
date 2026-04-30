import { join } from 'node:path';
import { Shell, test } from '@microsoft/tui-test';

import { waitForView } from './helpers.js';

const cliPath = join(process.cwd(), 'src', 'cli', 'cli.ts');

test.use({
  shell: Shell.Bash,
  rows: 30,
  columns: 100,
  env: {
    OPENROUTER_API_KEY: 'test-key',
    // Skip user-level noetic config so plugin paths from the host machine
    // don't drag a second React copy into the workspace's resolver.
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

test('Ctrl+C while idle shows the exit hint', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
  terminal.write('\x03');
  await waitForView(terminal, 'Press Ctrl+C again to exit');
});

test('hint clears after the double-press window expires', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
  terminal.write('\x03');
  await waitForView(terminal, 'Press Ctrl+C again to exit');
  // 800 ms window + buffer for paint
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const view = terminal.serialize().view;
  if (view.includes('Press Ctrl+C again to exit')) {
    throw new Error(`Expected hint to clear after window. View:\n${view}`);
  }
});

test('double-pressing Ctrl+C exits the process cleanly', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
  // Send both bytes in a single write — tui-test's virtual rendering is
  // slow enough that interleaving a `waitForView` between presses can push
  // the second one past the 800 ms double-press window. Two bytes in one
  // write land back-to-back at Ink's input handler.
  terminal.write('\x03\x03');
  // After exit, Ink unmounts and the prompt placeholder leaves the screen.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const view = terminal.serialize().view;
    if (!view.includes('Type a message...')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Expected TUI to unmount after double Ctrl+C. Final view:\n${terminal.serialize().view}`,
  );
});
