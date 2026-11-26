/**
 * The step-bootstrap child runs a step out of process on a harness of its
 * own, with in-memory adapters: the parent's named adapters do not reach it.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const BOOTSTRAP = fileURLToPath(new URL('../../src/harness/step-bootstrap.ts', import.meta.url));
const REGISTRY = fileURLToPath(new URL('../fixtures/step-bootstrap-registry.ts', import.meta.url));

/** Runs `stepId` in a bootstrap child and returns the one envelope it prints. */
async function runInChild(stepId: string): Promise<Record<string, unknown>> {
  const child = spawn(
    process.execPath,
    [
      'run',
      BOOTSTRAP,
    ],
    {
      stdio: [
        'pipe',
        'pipe',
        'inherit',
      ],
    },
  );
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stdin.end(
    `${JSON.stringify({
      stepId,
      serializedInput: null,
      executionId: 'exec-1',
      overrides: {},
      registryEntry: REGISTRY,
    })}\n`,
  );
  await new Promise((resolve) => child.on('close', resolve));
  return z.record(z.string(), z.unknown()).parse(JSON.parse(out.trim()));
}

describe('a step run out of process', () => {
  it('fails a step that names an adapter, saying named adapters do not reach the child', async () => {
    const envelope = await runInChild('bootstrap/named');
    expect(envelope.kind).toBe('error');
    const error = envelope.error;
    assert(typeof error === 'object' && error !== null);
    expect(Reflect.get(error, 'name')).toBe('NoeticConfigError');
    const message = String(Reflect.get(error, 'message'));
    expect(message).toContain("'builder'");
    expect(message).toContain('do not reach an out-of-process child');
    expect(message).toContain('Run the step in-process, or name no adapter in it.');
  }, 30e3);

  it("runs a step that names none on the child's own in-memory adapters", async () => {
    const envelope = await runInChild('bootstrap/unnamed');
    expect(envelope).toEqual({
      kind: 'ok',
      result: {
        fs: [
          'default',
        ],
        note: 'kept in memory',
      },
    });
  }, 30e3);
});
