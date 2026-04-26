/**
 * Unit tests for the InteractiveTerminal tool.
 *
 * Drives the tool against a fake ShellAdapter so no real `pilotty`
 * subprocess is spawned.
 */

import { describe, expect, test } from 'bun:test';
import type {
  ShellAdapter,
  ShellExecOptions,
  ShellExecResult,
  ToolExecutionContext,
} from '@noetic/core';
import type {
  InteractiveTerminalInput,
  InteractiveTerminalOutput,
} from '../src/tools/interactive-terminal.js';
import { createInteractiveTerminalTool } from '../src/tools/interactive-terminal.js';

//#region ShellAdapter helpers

interface RecordedCall {
  command: string;
  options: ShellExecOptions;
}

interface StubResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

function stubShell(result: StubResult = {}): {
  shell: ShellAdapter;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const shell: ShellAdapter = {
    async exec(command, options): Promise<ShellExecResult> {
      calls.push({
        command,
        options,
      });
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 0,
      };
    },
  };
  return {
    shell,
    calls,
  };
}

function tokenize(line: string): string[] {
  // Sufficient for our tests: handles single-quoted segments + bare words.
  // Pilotty argv elements never contain backslash-escapes that would
  // require full shell parsing.
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ') {
      i++;
      continue;
    }
    if (line[i] === "'") {
      let end = i + 1;
      while (end < line.length && line[end] !== "'") {
        end++;
      }
      tokens.push(line.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let end = i;
    while (end < line.length && line[end] !== ' ') {
      end++;
    }
    tokens.push(line.slice(i, end));
    i = end;
  }
  return tokens;
}

// Mirrors the stub in ask-user-tool.test.ts — sidesteps building the full
// ToolExecutionContext tree. Tools that don't read ctx fields (like this
// one) work fine; if a future change starts touching ctx the test will
// throw on first access.
function makeStubExecutionContext(): ToolExecutionContext {
  const empty: ToolExecutionContext = Object.create(null);
  return empty;
}

function isPromise<T>(value: unknown): value is Promise<T> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('then' in value)) {
    return false;
  }
  return typeof value.then === 'function';
}

async function runTool(
  tool: ReturnType<typeof createInteractiveTerminalTool>,
  input: InteractiveTerminalInput,
): Promise<InteractiveTerminalOutput> {
  const result = tool.execute(input, makeStubExecutionContext());
  if (!isPromise<InteractiveTerminalOutput>(result)) {
    throw new Error(
      'InteractiveTerminal.execute returned a non-Promise — tool() builder contract violation.',
    );
  }
  return await result;
}

const CWD = '/tmp/itt-test-cwd';

//#endregion

//#region argv shape per action

describe('createInteractiveTerminalTool — argv shape', () => {
  test('snapshot defaults to text format and omits -s when no session', async () => {
    const { shell, calls } = stubShell({
      stdout: 'screen body',
    });
    const tool = createInteractiveTerminalTool(CWD, shell);

    const out = await runTool(tool, {
      action: 'snapshot',
    });

    expect(calls).toHaveLength(1);
    const tokens = tokenize(calls[0].command);
    // tokens[0] is the absolute path to pilotty bin
    expect(tokens.slice(1)).toEqual([
      'snapshot',
      '--format',
      'text',
    ]);
    expect(calls[0].options.cwd).toBe(CWD);
    expect(out.action).toBe('snapshot');
    expect(out.exitCode).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.output).toBe('screen body');
  });

  test('snapshot passes session, settle, await-change, timeout, format', async () => {
    const { shell, calls } = stubShell({
      stdout: '{}',
    });
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'snapshot',
      session: 'editor',
      format: 'full',
      settleMs: 200,
      awaitChange: 'abc123',
      timeoutMs: 5000,
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'snapshot',
      '--format',
      'full',
      '-s',
      'editor',
      '--settle',
      '200',
      '--await-change',
      'abc123',
      '--timeout',
      '5000',
    ]);
  });

  test('key passes session, delay, and the key payload', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'key',
      session: 'editor',
      delayMs: 50,
      key: 'Ctrl+C',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'key',
      '-s',
      'editor',
      '--delay',
      '50',
      'Ctrl+C',
    ]);
  });

  test('key with delayMs boundary values builds correctly', async () => {
    for (const delayMs of [
      0,
      1,
      1e4,
    ]) {
      const { shell, calls } = stubShell();
      const tool = createInteractiveTerminalTool(CWD, shell);

      await runTool(tool, {
        action: 'key',
        key: 'Enter',
        delayMs,
      });

      const tokens = tokenize(calls[0].command);
      expect(tokens.slice(1)).toEqual([
        'key',
        '--delay',
        String(delayMs),
        'Enter',
      ]);
    }
  });

  test('key rejects delayMs above 10000 at the schema layer', () => {
    const { shell } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);
    // Schema rejection surfaces as a thrown validation error from the
    // tool builder. We accept either rejection (zod-validated) or a
    // structured "invalid input" path; what matters is the exec call
    // never happens. Confirm by asserting via parse().
    const parsed = tool.input.safeParse({
      action: 'key',
      key: 'Enter',
      delayMs: 10001,
    });
    expect(parsed.success).toBe(false);
  });

  test('type quotes whitespace text correctly', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'type',
      text: 'hello world',
      session: 'shell',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'type',
      '-s',
      'shell',
      'hello world',
    ]);
  });

  test('wait-for sets --regex and --timeout flags', async () => {
    const { shell, calls } = stubShell({
      stdout: '{"found":true}',
    });
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'wait-for',
      pattern: 'Saved',
      regex: true,
      timeoutMs: 3000,
      session: 'editor',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'wait-for',
      '-s',
      'editor',
      '--regex',
      '--timeout',
      '3000',
      'Saved',
    ]);
  });

  test('wait-for omits --regex when not set', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'wait-for',
      pattern: 'Saved',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'wait-for',
      'Saved',
    ]);
  });

  test('kill targets the named session', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'kill',
      session: 'editor',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'kill',
      '-s',
      'editor',
    ]);
  });

  test('list-sessions takes no flags', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'list-sessions',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'list-sessions',
    ]);
  });

  test('click sends row + col after optional session', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'click',
      row: 4,
      col: 12,
      session: 'app',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'click',
      '-s',
      'app',
      '4',
      '12',
    ]);
  });

  test('scroll appends optional amount', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'scroll',
      direction: 'down',
      amount: 3,
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'scroll',
      'down',
      '3',
    ]);
  });

  test('scroll without amount uses pilotty default', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'scroll',
      direction: 'up',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'scroll',
      'up',
    ]);
  });
});

//#endregion

//#region spawn argv

describe('createInteractiveTerminalTool — spawn argv', () => {
  test('spawn appends user command verbatim after --', async () => {
    const { shell, calls } = stubShell({
      stdout: '{"type":"session_created"}',
    });
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'spawn',
      command: 'htop',
      name: 'monitor',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'spawn',
      '--name',
      'monitor',
      '--',
      'htop',
    ]);
  });

  test('spawn without --name omits the flag', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'spawn',
      command: 'top',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'spawn',
      '--',
      'top',
    ]);
  });

  test('spawn whitespace-splits user command into argv tokens', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'spawn',
      command: 'vim file.txt',
    });

    const tokens = tokenize(calls[0].command);
    expect(tokens.slice(1)).toEqual([
      'spawn',
      '--',
      'vim',
      'file.txt',
    ]);
  });

  test('spawn rejects shell-injection attempts via the validator (semicolon path)', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    const out = await runTool(tool, {
      action: 'spawn',
      command: 'htop; rm -rf /tmp/x',
    });

    expect(calls).toHaveLength(0);
    expect(out.output).toContain('High-risk command blocked');
  });

  test('spawn passes --cwd when supplied', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    await runTool(tool, {
      action: 'spawn',
      command: 'tig',
      cwd: '/repo',
    });

    expect(calls[0].command).toContain('--cwd');
    expect(calls[0].command).toContain('/repo');
  });

  test('spawn surfaces session=name in the result', async () => {
    const { shell } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);

    const out = await runTool(tool, {
      action: 'spawn',
      command: 'htop',
      name: 'monitor',
    });

    expect(out.session).toBe('monitor');
  });
});

//#endregion

//#region output assembly

describe('createInteractiveTerminalTool — output assembly', () => {
  test('non-zero exit code annotates output and includes stderr', async () => {
    const { shell } = stubShell({
      stdout: '',
      stderr: "Error: [SESSION_NOT_FOUND] Session 'x' not found",
      exitCode: 1,
    });
    const tool = createInteractiveTerminalTool(CWD, shell);

    const out = await runTool(tool, {
      action: 'snapshot',
      session: 'x',
    });

    expect(out.exitCode).toBe(1);
    expect(out.output).toContain('[SESSION_NOT_FOUND]');
    expect(out.output).toContain('Command exited with code 1');
  });

  test('snapshot text format returns stdout verbatim under truncation limit', async () => {
    const { shell } = stubShell({
      stdout: 'small body',
    });
    const tool = createInteractiveTerminalTool(CWD, shell);

    const out = await runTool(tool, {
      action: 'snapshot',
    });

    expect(out.output).toBe('small body');
    expect(out.truncated).toBe(false);
  });

  test('snapshot text format truncates large output and appends a marker', async () => {
    const huge = `${'line\n'.repeat(5e3)}TAIL_MARKER`;
    const { shell } = stubShell({
      stdout: huge,
    });
    const tool = createInteractiveTerminalTool(CWD, shell);

    const out = await runTool(tool, {
      action: 'snapshot',
    });

    expect(out.truncated).toBe(true);
    expect(out.output).toContain('TAIL_MARKER');
    expect(out.output).toMatch(/Output truncated to last/);
  });

  test('snapshot json formats are also truncated to bound the agent context', async () => {
    const huge = 'x'.repeat(2e5);
    const { shell } = stubShell({
      stdout: huge,
    });
    const tool = createInteractiveTerminalTool(CWD, shell);

    const out = await runTool(tool, {
      action: 'snapshot',
      format: 'full',
    });

    expect(out.truncated).toBe(true);
    expect(out.output.length).toBeLessThan(huge.length);
    expect(out.output).toMatch(/Output truncated to last/);
  });

  test('non-snapshot actions pass output through verbatim regardless of size', async () => {
    const huge = 'x'.repeat(2e5);
    const { shell } = stubShell({
      stdout: huge,
    });
    const tool = createInteractiveTerminalTool(CWD, shell);

    const out = await runTool(tool, {
      action: 'list-sessions',
    });

    expect(out.output.length).toBe(huge.length);
    expect(out.truncated).toBe(false);
  });
});

//#endregion

//#region readonly gate

describe('createInteractiveTerminalTool — readonly gate', () => {
  test('readonly: spawn of `claude` is rejected and shell is never called', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell, {
      readonly: true,
    });

    const out = await runTool(tool, {
      action: 'spawn',
      command: 'claude',
      name: 'agent',
    });

    expect(calls).toHaveLength(0);
    expect(out.exitCode).toBeUndefined();
    expect(out.output).toContain('Read-only mode');
    expect(out.session).toBe('agent');
  });

  test('readonly: spawn of `vim` is rejected', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell, {
      readonly: true,
    });

    const out = await runTool(tool, {
      action: 'spawn',
      command: 'vim file',
    });

    expect(calls).toHaveLength(0);
    expect(out.output).toContain('Read-only mode');
  });

  test('readonly: spawn of `htop` is allowed', async () => {
    const { shell, calls } = stubShell({
      stdout: '{}',
    });
    const tool = createInteractiveTerminalTool(CWD, shell, {
      readonly: true,
    });

    const out = await runTool(tool, {
      action: 'spawn',
      command: 'htop',
    });

    expect(calls).toHaveLength(1);
    expect(out.exitCode).toBe(0);
  });

  test('readonly: rm -rf is blocked by the high-risk pattern check, not the readonly list', async () => {
    const { shell, calls } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell, {
      readonly: true,
    });

    const out = await runTool(tool, {
      action: 'spawn',
      command: 'rm -rf /tmp/x',
    });

    expect(calls).toHaveLength(0);
    expect(out.output).toContain('High-risk command blocked');
  });

  test('non-readonly: spawn of `claude` is allowed (gate is mode-scoped)', async () => {
    const { shell, calls } = stubShell({
      stdout: '{}',
    });
    const tool = createInteractiveTerminalTool(CWD, shell);

    const out = await runTool(tool, {
      action: 'spawn',
      command: 'claude',
    });

    expect(calls).toHaveLength(1);
    expect(out.exitCode).toBe(0);
  });

  test('readonly: non-spawn actions still pass through', async () => {
    const { shell, calls } = stubShell({
      stdout: '[]',
    });
    const tool = createInteractiveTerminalTool(CWD, shell, {
      readonly: true,
    });

    await runTool(tool, {
      action: 'list-sessions',
    });
    await runTool(tool, {
      action: 'snapshot',
      session: 'editor',
    });
    await runTool(tool, {
      action: 'key',
      key: 'Enter',
      session: 'editor',
    });

    expect(calls).toHaveLength(3);
  });
});

//#endregion

//#region schema rejections

describe('createInteractiveTerminalTool — schema', () => {
  test('rejects unknown action', () => {
    const { shell } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);
    const parsed = tool.input.safeParse({
      action: 'foo',
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects spawn without command', () => {
    const { shell } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);
    const parsed = tool.input.safeParse({
      action: 'spawn',
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects key without key field', () => {
    const { shell } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);
    const parsed = tool.input.safeParse({
      action: 'key',
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects negative click coordinates', () => {
    const { shell } = stubShell();
    const tool = createInteractiveTerminalTool(CWD, shell);
    const parsed = tool.input.safeParse({
      action: 'click',
      row: -1,
      col: 0,
    });
    expect(parsed.success).toBe(false);
  });
});

//#endregion
