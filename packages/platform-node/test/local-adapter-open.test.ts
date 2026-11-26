/**
 * The local adapter's `open`: a link to this machine, through which a caller
 * starts a process and holds its stdio, shaped by the adapter's options.
 */

import { describe, expect, it } from 'bun:test';
import type { LocalAgentCommand } from '../src/local-subprocess-adapter';
import { createLocalSubprocessAdapter } from '../src/local-subprocess-adapter';

describe('local adapter open', () => {
  it('spawns a process and carries its stdio and exit code', async () => {
    const link = await createLocalSubprocessAdapter().open({});
    try {
      const process = await link.spawn({
        command: 'cat',
      });
      const writer = process.writable.getWriter();
      await writer.write(new TextEncoder().encode('ping\n'));
      await writer.close();
      expect(await new Response(process.readable).text()).toBe('ping\n');
      expect(await process.exited).toBe(0);
    } finally {
      await link.close();
    }
  });

  it('launches through the wrap and stderr options it was made with', async () => {
    const wrapped: LocalAgentCommand[] = [];
    let stderr = '';
    const adapter = createLocalSubprocessAdapter({
      keeper: false,
      onStderr: (chunk) => {
        stderr += chunk;
      },
      wrap: (command) => {
        wrapped.push(command);
        return {
          command: 'node',
          args: [
            '-e',
            "process.stderr.write('wrapped:' + process.argv[1])",
            command.command,
          ],
        };
      },
    });
    const link = await adapter.open({});
    try {
      const process = await link.launch({
        command: 'the-agent',
      });
      await new Response(process.readable).text();
      expect(wrapped.map((command) => command.command)).toEqual([
        'the-agent',
      ]);
      expect(stderr).toBe('wrapped:the-agent');
    } finally {
      await link.close();
    }
  });

  it('still runs steps and commands', async () => {
    const adapter = createLocalSubprocessAdapter();
    const step = await adapter.spawn({
      kind: 'step',
      stepId: 'inline',
      serializedInput: null,
      executionId: 'e-1',
      overrides: {},
      _localExecutor: async () => 'ran',
    });
    expect((await step.settled).metadata?.result).toBe('ran');
    const command = await adapter.spawn({
      command: 'node',
      args: [
        '-e',
        "process.stdout.write('done')",
      ],
      stdin: '',
    });
    expect((await command.settled).metadata?.result).toBe('done');
  });
});
