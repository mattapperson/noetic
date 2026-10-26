/**
 * A `process` request that carries `stdin` runs to a result: the adapter writes its
 * input, collects stdout as the handle's `result`, and puts stderr in a failure.
 * That is what a JSON workflow `runCode` node needs to run on the local adapter.
 */

import { describe, expect, it } from 'bun:test';
import { AgentHarness, workflow } from '@noetic-tools/core';
import { createLocalSubprocessAdapter } from '../src/local-subprocess-adapter';

const ECHO_UPPER =
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))";

function run(args: string[], stdin?: string) {
  return createLocalSubprocessAdapter().spawn({
    kind: 'process',
    command: 'node',
    args,
    stdin,
  });
}

describe('local adapter process I/O', () => {
  it('writes stdin and settles with stdout as the result', async () => {
    const { settled } = await run(
      [
        '-e',
        ECHO_UPPER,
      ],
      'hello',
    );
    const final = await settled;
    expect(final.status).toBe('completed');
    expect(final.metadata?.result).toBe('HELLO');
  });

  it('collects output larger than a pipe buffer before settling', async () => {
    const { settled } = await run(
      [
        '-e',
        "process.stdout.write('x'.repeat(5e5))",
      ],
      '',
    );
    const final = await settled;
    expect(typeof final.metadata?.result).toBe('string');
    expect(String(final.metadata?.result)).toHaveLength(5e5);
  });

  it('fails with the end of stderr in the error', async () => {
    const { settled } = await run(
      [
        '-e',
        "process.stderr.write('boom: bad input'); process.exit(2)",
      ],
      'x',
    );
    const final = await settled;
    expect(final.status).toBe('failed');
    expect(final.metadata?.exitCode).toBe(2);
    expect(final.metadata?.error?.message).toContain('code 2');
    expect(final.metadata?.error?.message).toContain('boom: bad input');
    expect(final.metadata?.result).toBeUndefined();
  });

  it('settles when the child exits without reading its input', async () => {
    const { settled } = await run(
      [
        '-e',
        "process.stdout.write('done')",
      ],
      'x'.repeat(2e5),
    );
    const final = await settled;
    expect(final.status).toBe('completed');
    expect(final.metadata?.result).toBe('done');
  });

  it('a request without stdin captures nothing', async () => {
    const { settled } = await run([
      '-e',
      "process.stdout.write('ignored')",
    ]);
    const final = await settled;
    expect(final.status).toBe('completed');
    expect(final.metadata?.result).toBeUndefined();
  });

  it('runs a JSON workflow runCode node end to end', async () => {
    const harness = new AgentHarness({
      name: 'json-runcode',
      params: {},
      environment: {
        subprocess: createLocalSubprocessAdapter(),
      },
    });
    const flow = workflow({
      id: 'flow',
      document: {
        version: 1,
        root: {
          kind: 'loop',
          id: 'count',
          maxIterations: 'infinity',
          body: {
            kind: 'runCode',
            id: 'tick',
            execute:
              "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);process.stdout.write(JSON.stringify({n:x.n+1}))})",
          },
          until: {
            kind: 'expr',
            expr: 'n = 3',
          },
        },
      },
    });
    expect(await harness.run(flow, '{"n":0}', harness.createContext())).toBe('{"n":3}');
  });
});
