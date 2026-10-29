import { expect } from 'bun:test';
import type { AnyProfile, BlobRef, Receipt, Ref } from '@noetic-tools/types';

/** A well-formed ref of `kind`. */
export function refOf<const K extends string>(kind: K, id = 'r1'): Ref<K> {
  return {
    $ref: {
      connection: 'app',
      kind,
      id,
      seal: 'sealed',
    },
  };
}

/** A well-formed blob reference. */
export function blobOf(mimeType = 'application/octet-stream'): BlobRef {
  return {
    $blob: {
      uri: `noetic-artifact:sha256:${'a'.repeat(64)}`,
      mimeType,
      bytes: 3,
      sha256: 'a'.repeat(64),
    },
  };
}

/** A well-formed receipt. */
export function receiptOf(actionId = 'act-1'): Receipt {
  return {
    actionId,
    cursor: 'c1',
  };
}

/** One operation's schema expectations. */
export interface OperationCase {
  readonly input: object;
  readonly badInput: object | string;
  readonly output: object;
  readonly badOutput: object | string;
}

/** Asserts an operation's input and output schemas accept and refuse as expected. */
export function checkOperation(profile: AnyProfile, name: string, cases: OperationCase): void {
  const op = profile.operations[name];
  expect(op).toBeDefined();
  if (!op) {
    return;
  }
  expect(op.input.safeParse(cases.input).success).toBe(true);
  expect(op.input.safeParse(cases.badInput).success).toBe(false);
  expect(op.output.safeParse(cases.output).success).toBe(true);
  expect(op.output.safeParse(cases.badOutput).success).toBe(false);
}

/** The flags of an operation, normalized for comparison. */
export function flagsOf(
  profile: AnyProfile,
  name: string,
): Readonly<Record<string, boolean | string>> {
  const op = profile.operations[name];
  const flags: Record<string, boolean | string> = {};
  if (!op) {
    return flags;
  }
  for (const key of [
    'eager',
    'effects',
    'once',
    'guarded',
  ] as const) {
    if (op[key]) {
      flags[key] = true;
    }
  }
  if (op.required === false) {
    flags.optional = true;
  }
  if (op.sense) {
    flags.sense = op.sense;
  }
  return flags;
}
