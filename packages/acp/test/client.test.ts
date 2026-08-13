/**
 * Client-side ACP capabilities, exercised over the real wire: the agent calls
 * `fs/*`, `terminal/*`, and `session/request_permission`, and Noetic's adapters
 * answer. These prove the central claim of the ACP rewrite — that a sub-agent's
 * file and shell access flows through Noetic rather than around it.
 */

import { describe, expect, test } from 'bun:test';
import type * as acp from '@zed-industries/agent-client-protocol';
import { sliceLines } from '../src/client';
import { createAcpTestRig, MemoryFs, RecordingShell } from './_helpers';

const PROMPT: acp.ContentBlock[] = [
  {
    type: 'text',
    text: 'go',
  },
];

describe('fs capabilities', () => {
  test('fs/read_text_file is served from the FsAdapter', async () => {
    const fs = new MemoryFs();
    fs.files.set('/workspace/a.txt', 'alpha\nbeta\ngamma');
    let content: string | undefined;

    const rig = await createAcpTestRig({
      fs,
      script: {
        onPrompt: async (conn, params) => {
          const response = await conn.readTextFile({
            sessionId: params.sessionId,
            path: '/workspace/a.txt',
          });
          content = response.content;
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(content).toBe('alpha\nbeta\ngamma');
    await rig.close();
  });

  test('fs/read_text_file honours the 1-indexed line window', async () => {
    const fs = new MemoryFs();
    fs.files.set('/workspace/a.txt', 'one\ntwo\nthree\nfour');
    let content: string | undefined;

    const rig = await createAcpTestRig({
      fs,
      script: {
        onPrompt: async (conn, params) => {
          const response = await conn.readTextFile({
            sessionId: params.sessionId,
            path: '/workspace/a.txt',
            line: 2,
            limit: 2,
          });
          content = response.content;
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(content).toBe('two\nthree');
    await rig.close();
  });

  test('fs/write_text_file writes through the FsAdapter and creates parents', async () => {
    const fs = new MemoryFs();

    const rig = await createAcpTestRig({
      fs,
      script: {
        onPrompt: async (conn, params) => {
          await conn.writeTextFile({
            sessionId: params.sessionId,
            path: '/workspace/nested/out.txt',
            content: 'written',
          });
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(fs.files.get('/workspace/nested/out.txt')).toBe('written');
    expect(fs.dirs.has('/workspace/nested')).toBe(true);
    await rig.close();
  });

  test('a withdrawn write capability rejects the call instead of writing', async () => {
    const fs = new MemoryFs();
    let failure: unknown;

    const rig = await createAcpTestRig({
      fs,
      capabilities: {
        writeTextFile: false,
      },
      script: {
        onPrompt: async (conn, params) => {
          try {
            await conn.writeTextFile({
              sessionId: params.sessionId,
              path: '/workspace/out.txt',
              content: 'nope',
            });
          } catch (error) {
            failure = error;
          }
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(failure).toBeDefined();
    expect(fs.files.has('/workspace/out.txt')).toBe(false);
    await rig.close();
  });
});

describe('terminal capabilities', () => {
  test('terminal/create runs through the ShellAdapter and reports output', async () => {
    const shell = new RecordingShell();
    shell.script.set("echo 'hello world'", {
      stdout: 'hello world\n',
      exitCode: 0,
    });
    let output: acp.TerminalOutputResponse | undefined;
    let exit: acp.WaitForTerminalExitResponse | undefined;

    const rig = await createAcpTestRig({
      shell,
      script: {
        onPrompt: async (conn, params) => {
          const terminal = await conn.createTerminal({
            sessionId: params.sessionId,
            command: 'echo',
            args: [
              'hello world',
            ],
          });
          exit = await terminal.waitForExit();
          output = await terminal.currentOutput();
          await terminal.release();
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]?.command).toBe("echo 'hello world'");
    expect(shell.calls[0]?.options.cwd).toBe('/workspace');
    expect(output?.output).toBe('hello world\n');
    expect(output?.truncated).toBe(false);
    expect(exit?.exitCode).toBe(0);
    await rig.close();
  });

  test('a non-zero exit is reported as the exit code, not an error', async () => {
    const shell = new RecordingShell();
    shell.script.set('false', {
      exitCode: 3,
    });
    let exit: acp.WaitForTerminalExitResponse | undefined;

    const rig = await createAcpTestRig({
      shell,
      script: {
        onPrompt: async (conn, params) => {
          const terminal = await conn.createTerminal({
            sessionId: params.sessionId,
            command: 'false',
          });
          exit = await terminal.waitForExit();
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(exit?.exitCode).toBe(3);
    await rig.close();
  });

  test('terminal/kill aborts the running command', async () => {
    const shell = new RecordingShell();
    // Never resolves on its own: only the kill's abort signal can end this
    // command, so a passing test proves the abort actually reached the shell.
    shell.script.set('sleep 60', {
      hold: new Promise<void>(() => undefined),
    });
    let exit: acp.WaitForTerminalExitResponse | undefined;

    const rig = await createAcpTestRig({
      shell,
      script: {
        onPrompt: async (conn, params) => {
          const terminal = await conn.createTerminal({
            sessionId: params.sessionId,
            command: 'sleep',
            args: [
              '60',
            ],
          });
          await terminal.kill();
          exit = await terminal.waitForExit();
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(exit?.signal).toBe('SIGKILL');
    expect(exit?.exitCode).toBeNull();
    await rig.close();
  });

  test('output is truncated to the requested byte limit, oldest first', async () => {
    const shell = new RecordingShell();
    shell.script.set('big', {
      stdout: 'abcdefghij',
    });
    let output: acp.TerminalOutputResponse | undefined;

    const rig = await createAcpTestRig({
      shell,
      script: {
        onPrompt: async (conn, params) => {
          const terminal = await conn.createTerminal({
            sessionId: params.sessionId,
            command: 'big',
            outputByteLimit: 4,
          });
          await terminal.waitForExit();
          output = await terminal.currentOutput();
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    // The single 10-byte chunk exceeds the 4-byte cap, so it is dropped whole
    // and the response is flagged as truncated rather than silently complete.
    expect(output?.truncated).toBe(true);
    await rig.close();
  });

  test('a withdrawn terminal capability rejects the call', async () => {
    const shell = new RecordingShell();
    let failure: unknown;

    const rig = await createAcpTestRig({
      shell,
      capabilities: {
        terminal: false,
      },
      script: {
        onPrompt: async (conn, params) => {
          try {
            await conn.createTerminal({
              sessionId: params.sessionId,
              command: 'echo',
            });
          } catch (error) {
            failure = error;
          }
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(failure).toBeDefined();
    expect(shell.calls).toHaveLength(0);
    await rig.close();
  });
});

describe('permission round-trips', () => {
  const OPTIONS: acp.PermissionOption[] = [
    {
      optionId: 'yes',
      name: 'Allow once',
      kind: 'allow_once',
    },
    {
      optionId: 'always',
      name: 'Always allow',
      kind: 'allow_always',
    },
    {
      optionId: 'no',
      name: 'Reject',
      kind: 'reject_once',
    },
  ];

  function permissionRequest(sessionId: string, kind: acp.ToolKind, title: string) {
    return {
      sessionId,
      options: OPTIONS,
      toolCall: {
        toolCallId: 'call-1',
        title,
        kind,
      },
    };
  }

  test('an allow rule selects an allow option', async () => {
    let outcome: acp.RequestPermissionResponse | undefined;
    const rig = await createAcpTestRig({
      policy: {
        default: 'deny',
        allow: [
          {
            kind: 'read',
          },
        ],
      },
      script: {
        onPrompt: async (conn, params) => {
          outcome = await conn.requestPermission(
            permissionRequest(params.sessionId, 'read', 'Read a file'),
          );
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(outcome?.outcome).toEqual({
      outcome: 'selected',
      optionId: 'yes',
    });
    await rig.close();
  });

  test('the default deny applies when nothing matches', async () => {
    let outcome: acp.RequestPermissionResponse | undefined;
    const rig = await createAcpTestRig({
      policy: {
        allow: [
          {
            kind: 'read',
          },
        ],
      },
      script: {
        onPrompt: async (conn, params) => {
          outcome = await conn.requestPermission(
            permissionRequest(params.sessionId, 'execute', 'Run rm -rf /'),
          );
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(outcome?.outcome).toEqual({
      outcome: 'selected',
      optionId: 'no',
    });
    await rig.close();
  });

  test('steering decides when the policy abstains', async () => {
    let outcome: acp.RequestPermissionResponse | undefined;
    const rig = await createAcpTestRig({
      steer: async () => ({
        decision: 'allow',
        reason: 'steering rule allowed it',
      }),
      script: {
        onPrompt: async (conn, params) => {
          outcome = await conn.requestPermission(
            permissionRequest(params.sessionId, 'edit', 'Edit index.ts'),
          );
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(outcome?.outcome).toEqual({
      outcome: 'selected',
      optionId: 'yes',
    });
    await rig.close();
  });

  test('the async handler runs only after policy and steering abstain', async () => {
    const seen: string[] = [];
    let outcome: acp.RequestPermissionResponse | undefined;
    const rig = await createAcpTestRig({
      steer: async () => {
        seen.push('steer');
        return undefined;
      },
      handler: async () => {
        seen.push('handler');
        return {
          decision: 'allow',
          optionId: 'always',
        };
      },
      script: {
        onPrompt: async (conn, params) => {
          outcome = await conn.requestPermission(
            permissionRequest(params.sessionId, 'edit', 'Edit index.ts'),
          );
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(seen).toEqual([
      'steer',
      'handler',
    ]);
    expect(outcome?.outcome).toEqual({
      outcome: 'selected',
      optionId: 'always',
    });
    await rig.close();
  });

  test('a deny rule beats an overlapping allow rule', async () => {
    let outcome: acp.RequestPermissionResponse | undefined;
    const rig = await createAcpTestRig({
      policy: {
        allow: [
          {
            kind: 'execute',
          },
        ],
        deny: [
          {
            title: 'rm -rf',
          },
        ],
      },
      script: {
        onPrompt: async (conn, params) => {
          outcome = await conn.requestPermission(
            permissionRequest(params.sessionId, 'execute', 'Run rm -rf /tmp'),
          );
        },
      },
    });
    const session = await rig.connection.newSession({
      cwd: '/workspace',
    });
    await session.prompt({
      content: PROMPT,
    });

    expect(outcome?.outcome).toEqual({
      outcome: 'selected',
      optionId: 'no',
    });
    await rig.close();
  });
});

describe('sliceLines', () => {
  const CONTENT = 'l1\nl2\nl3\nl4\nl5';

  test('returns the whole file with no window', () => {
    expect(sliceLines(CONTENT)).toBe(CONTENT);
  });

  test('treats line 1 as the start of the file', () => {
    expect(sliceLines(CONTENT, 1)).toBe(CONTENT);
  });

  test('line 2 drops exactly the first line', () => {
    expect(sliceLines(CONTENT, 2)).toBe('l2\nl3\nl4\nl5');
  });

  test('line 3 with limit 1 returns exactly that line', () => {
    expect(sliceLines(CONTENT, 3, 1)).toBe('l3');
  });

  test('a limit past the end returns what exists', () => {
    expect(sliceLines(CONTENT, 4, 99)).toBe('l4\nl5');
  });

  test('null line and limit are treated as absent', () => {
    expect(sliceLines(CONTENT, null, null)).toBe(CONTENT);
  });
});
