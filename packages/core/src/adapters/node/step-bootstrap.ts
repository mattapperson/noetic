/**
 * Step-bootstrap child entrypoint for the local subprocess adapter.
 *
 * The parent adapter spawns this module with `bun run <step-bootstrap.ts>`.
 * It:
 *
 *   1. Reads a single JSON envelope from stdin (one frame, newline-terminated).
 *   2. Dynamically imports the registry entry module so its module-level
 *      `registerStep` side effects populate the registry in this process.
 *   3. Looks up the requested step by id.
 *   4. Constructs a minimal harness (in-memory adapters, no nested
 *      subprocess) and runs the step.
 *   5. Serialises the result (or error) as a JSON envelope on stdout.
 *
 * Protocol: the parent reads **exactly one JSON line** from stdout on child
 * exit:
 *
 *   - Success: `{"kind":"ok","result":<value>}`
 *   - Failure: `{"kind":"error","error":{"message":"...","name":"...","stack":"...","noeticError":...}}`
 *
 * On failure the process exits with code 1; on success, code 0. Uncaught
 * errors are caught and reported through the same envelope so the parent
 * never sees a silent crash.
 */

import { AgentHarness } from '../../runtime/agent-harness';
import { lookupStep } from '../../runtime/step-registry';
import type { StepSubprocessOverrides } from '../../types/subprocess-adapter';

//#region Types

interface Envelope {
  stepId: string;
  serializedInput: unknown;
  executionId: string;
  overrides: StepSubprocessOverrides;
  registryEntry: string;
}

interface SerializedErrorEnvelope {
  message: string;
  name?: string;
  stack?: string;
  noeticError?: unknown;
}

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEnvelope(value: unknown): value is Envelope {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.stepId !== 'string' || typeof value.executionId !== 'string') {
    return false;
  }
  if (typeof value.registryEntry !== 'string') {
    return false;
  }
  if (!isRecord(value.overrides)) {
    return false;
  }
  return true;
}

function readStdinFrame(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) {
        return;
      }
      process.stdin.pause();
      resolve(buf.slice(0, nl));
    });
    process.stdin.on('end', () => {
      if (buf.length > 0) {
        resolve(buf);
        return;
      }
      reject(new Error('step-bootstrap: stdin closed before an envelope was received'));
    });
    process.stdin.on('error', reject);
  });
}

function serializeErrorFor(err: unknown): SerializedErrorEnvelope {
  if (err instanceof Error) {
    const payload: SerializedErrorEnvelope = {
      message: err.message,
      name: err.name,
      stack: err.stack,
    };
    if (isRecord(err) && 'noeticError' in err) {
      payload.noeticError = err.noeticError;
    }
    return payload;
  }
  return {
    message: typeof err === 'string' ? err : String(err),
  };
}

function writeEnvelope(payload: Record<string, unknown>): void {
  // A single newline-terminated JSON line — matches the parent parser's
  // contract in `local-subprocess-adapter.ts`.
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

//#endregion

//#region Main

async function main(): Promise<number> {
  const raw = await readStdinFrame();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    writeEnvelope({
      kind: 'error',
      error: serializeErrorFor(err),
    });
    return 1;
  }
  if (!isEnvelope(parsed)) {
    writeEnvelope({
      kind: 'error',
      error: {
        message: 'step-bootstrap: stdin envelope failed structural validation',
      },
    });
    return 1;
  }
  // Import the registry entry so module-level `registerStep` side effects
  // populate our registry before lookup. The parent guarantees the path is
  // absolute (see `local-subprocess-adapter.ts:spawnStepHandle`).
  await import(parsed.registryEntry);
  const step = lookupStep(parsed.stepId);
  if (!step) {
    writeEnvelope({
      kind: 'error',
      error: {
        message: `step-bootstrap: step "${parsed.stepId}" is not registered in the child runtime`,
      },
    });
    return 1;
  }
  const harness = new AgentHarness({
    name: `step-bootstrap-${parsed.stepId}`,
    params: {},
  });
  const ctx = harness.createContext({
    threadId: parsed.overrides.threadId,
    resourceId: parsed.overrides.resourceId,
    cwdInit: parsed.overrides.cwdInit,
  });
  try {
    const result = await harness.run(step, parsed.serializedInput, ctx);
    writeEnvelope({
      kind: 'ok',
      result,
    });
    return 0;
  } catch (err) {
    writeEnvelope({
      kind: 'error',
      error: serializeErrorFor(err),
    });
    return 1;
  }
}

void main()
  .then((code) => {
    // Flush before exit — `process.stdout.write` is async on some platforms
    // (block devices, sockets) and an immediate `process.exit` can truncate.
    process.stdout.once('drain', () => process.exit(code));
    if (process.stdout.writableLength === 0) {
      process.exit(code);
    }
  })
  .catch((err: unknown) => {
    writeEnvelope({
      kind: 'error',
      error: serializeErrorFor(err),
    });
    process.exit(1);
  });

//#endregion
