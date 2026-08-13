/**
 * Regression pin for `ContextInput`.
 *
 * `ContextConfig<TLayers>` is invariant in `TLayers` — its phantom `_shape`
 * field carries the type parameter in an invariant position — so the concrete
 * `ContextConfig<readonly [ScratchpadLayer]>` that `context()` infers is NOT
 * assignable to the defaulted `ContextConfig<readonly ContextLayer[]>`. Any
 * entry point that spells its parameter `ContextConfig | ContextLayer[]`
 * therefore rejects the `context()` builder's own output.
 *
 * Every case below passes a `context([...])` result — with a real layer, so the
 * inferred tuple is non-trivial and `_shape` is not `Record<string, never>` —
 * straight into `spawn`, `withContext`, and the `StepSpawn`/`StepWithContext`
 * literals. If any of those sites reverts to the `ContextConfig`-based union
 * these calls stop compiling, failing `bun run typecheck` (this directory is
 * inside the package tsconfig's `test/**\/*.ts` include).
 *
 * The bodies also assert at runtime that the config's layers reach the built
 * step, so the pin fails loudly if the interpreter's `hasLayersField`
 * discrimination stops unwrapping `{ layers }`.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextInput, ContextLayer } from '@noetic-tools/context';
import { scratchpad } from '@noetic-tools/context';
import type { Step, StepSpawn, StepWithContext } from '@noetic-tools/types';
import { context } from '../../src/builders/context-builder';
import { withContext } from '../../src/builders/provide-builder';
import { spawn } from '../../src/builders/spawn-builder';
import { runCode } from '../../src/builders/step-builders';

function makeChild(id: string): Step<unknown, string, string> {
  return runCode<unknown, string, string>({
    id,
    execute: async (input: string) => input,
  });
}

/**
 * Reads whichever `ContextInput` member was supplied back into a flat list.
 * Discriminates with the same `!Array.isArray` shape the interpreter uses:
 * `'layers' in value` alone does not narrow away the `ReadonlyArray` member.
 */
function hasLayersField(input: ContextInput): input is {
  readonly layers: readonly ContextLayer[];
} {
  return !Array.isArray(input) && 'layers' in input;
}

function layersOf(input: ContextInput): readonly ContextLayer[] {
  if (hasLayersField(input)) {
    return input.layers;
  }
  return input;
}

describe('ContextInput accepts the context() builder output', () => {
  it('spawn({ context: context([...]) }) compiles and carries the layers', () => {
    const config = context([
      scratchpad(),
    ]);

    const spawned = spawn({
      id: 'spawn-with-config',
      child: makeChild('spawn-with-config-child'),
      context: config,
    });

    assert(spawned.context);
    expect(layersOf(spawned.context).map((layer) => layer.id)).toEqual([
      'scratchpad',
    ]);
  });

  it('withContext({ context: context([...]) }) compiles and carries the layers', () => {
    const config = context([
      scratchpad(),
    ]);

    const provided = withContext({
      id: 'with-context-config',
      child: makeChild('with-context-config-child'),
      context: config,
    });

    expect(layersOf(provided.context).map((layer) => layer.id)).toEqual([
      'scratchpad',
    ]);
  });

  it('StepSpawn and StepWithContext literals accept a config directly', () => {
    const config = context([
      scratchpad(),
    ]);

    const spawnStep: StepSpawn<unknown, string, string> = {
      kind: 'spawn',
      id: 'literal-spawn',
      child: makeChild('literal-spawn-child'),
      context: config,
    };
    const withContextStep: StepWithContext<unknown, string, string> = {
      kind: 'withContext',
      id: 'literal-with-context',
      child: makeChild('literal-with-context-child'),
      context: config,
    };

    assert(spawnStep.context);
    expect(layersOf(spawnStep.context)).toHaveLength(1);
    expect(layersOf(withContextStep.context)).toHaveLength(1);
  });

  it('a bare readonly layer array is still accepted', () => {
    const layers: readonly ContextLayer[] = [
      scratchpad(),
    ];

    const spawned = spawn({
      id: 'spawn-with-readonly-array',
      child: makeChild('spawn-with-readonly-array-child'),
      context: layers,
    });

    assert(spawned.context);
    expect(layersOf(spawned.context).map((layer) => layer.id)).toEqual([
      'scratchpad',
    ]);
  });
});
