import { describe, expect, test } from 'bun:test';
import type { ShellAdapter, ShellExecOptions, ShellExecResult } from '@noetic/core';
import { BashOutputSchema, createBashTool } from '../src/tools/bash.js';
import { createEditTool, EditOutputSchema } from '../src/tools/edit.js';
import type { MutationPolicy } from '../src/tools/mutation-policy.js';
import { isProbablyMutatingShellCommand } from '../src/tools/mutation-policy.js';
import { createWriteTool, WriteOutputSchema } from '../src/tools/write.js';

const allowPolicy: MutationPolicy = {
  check: async () => ({
    allowed: true,
  }),
};

const denyPolicy: MutationPolicy = {
  check: async () => ({
    allowed: false,
    message: 'must use a task worktree',
  }),
};

function stubShell(): {
  shell: ShellAdapter;
  commands: string[];
} {
  const commands: string[] = [];
  return {
    commands,
    shell: {
      exec(command: string, _options: ShellExecOptions): Promise<ShellExecResult> {
        commands.push(command);
        return Promise.resolve({
          stdout: 'ok',
          stderr: '',
          exitCode: 0,
        });
      },
    },
  };
}

function stubFs() {
  return {
    readFile: async () => Buffer.from('old'),
    readFileText: async () => 'old',
    writeFile: async () => undefined,
    mkdir: async () => undefined,
    access: async () => undefined,
    stat: async () => ({
      size: 0,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isFile: () => true,
    }),
    lstat: async () => ({
      size: 0,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isFile: () => true,
    }),
    readdir: async () => [],
  };
}

describe('mutation policy', () => {
  test('classifies common mutating shell commands', () => {
    expect(isProbablyMutatingShellCommand('git status')).toBe(false);
    expect(isProbablyMutatingShellCommand('git add package.json')).toBe(true);
    expect(isProbablyMutatingShellCommand('bun install')).toBe(true);
    expect(isProbablyMutatingShellCommand('sed -n "1,5p" file.ts')).toBe(false);
    expect(isProbablyMutatingShellCommand('sed -i s/a/b/ file.ts')).toBe(true);
    expect(isProbablyMutatingShellCommand('echo hi > file.txt')).toBe(true);
  });

  test('Bash blocks mutating commands before shell execution when policy denies', async () => {
    const { shell, commands } = stubShell();
    const tool = createBashTool('/repo', shell, denyPolicy);
    const exec = tool.execute(
      {
        command: 'git add package.json',
      },
      Object.create(null),
    );
    const result = BashOutputSchema.parse(await resolveToolExecution(exec));
    expect(result.output).toContain('must use a task worktree');
    expect(commands).toHaveLength(0);
  });

  test('Bash allows read-only commands without consulting policy', async () => {
    let called = false;
    const { shell } = stubShell();
    const tool = createBashTool('/repo', shell, {
      check: async () => {
        called = true;
        return {
          allowed: false,
          message: 'blocked',
        };
      },
    });
    const exec = tool.execute(
      {
        command: 'git status',
      },
      Object.create(null),
    );
    const result = BashOutputSchema.parse(await resolveToolExecution(exec));
    expect(result.cancelled).toBe(false);
    expect(result.output).toBe('(no output)');
    expect(called).toBe(false);
  });

  test('Write and Edit return policy denial as failed tool output', async () => {
    const fs = stubFs();
    const write = WriteOutputSchema.parse(
      await resolveToolExecution(
        createWriteTool('/repo', fs, denyPolicy).execute(
          {
            path: 'file.txt',
            content: 'new',
          },
          Object.create(null),
        ),
      ),
    );
    expect(write.success).toBe(false);
    expect(write.message).toContain('task worktree');

    const edit = EditOutputSchema.parse(
      await resolveToolExecution(
        createEditTool('/repo', fs, denyPolicy).execute(
          {
            path: 'file.txt',
            oldText: 'old',
            newText: 'new',
          },
          Object.create(null),
        ),
      ),
    );
    expect(edit.success).toBe(false);
    expect(edit.message).toContain('task worktree');

    const allowedWrite = WriteOutputSchema.parse(
      await resolveToolExecution(
        createWriteTool('/repo', fs, allowPolicy).execute(
          {
            path: 'file.txt',
            content: 'new',
          },
          Object.create(null),
        ),
      ),
    );
    expect(allowedWrite.success).toBe(true);
  });
});

function isAsyncGenerator<T>(value: unknown): value is AsyncGenerator<unknown, T> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

async function resolveToolExecution<T>(value: Promise<T> | AsyncGenerator<unknown, T>): Promise<T> {
  if (!isAsyncGenerator<T>(value)) {
    return value;
  }
  while (true) {
    const next = await value.next();
    if (next.done) {
      return next.value;
    }
  }
}
