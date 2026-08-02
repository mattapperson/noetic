import { describe, expect, it } from 'bun:test';
import * as context from '@noetic-tools/context';
import * as shim from '../src/index';

describe('@noetic-tools/memory deprecation shim', () => {
  it('re-exports every name from @noetic-tools/context', () => {
    const missing = Object.keys(context).filter((name) => !(name in shim));
    expect(missing).toEqual([]);
  });

  it('adds nothing of its own', () => {
    const extra = Object.keys(shim).filter((name) => !(name in context));
    expect(extra).toEqual([]);
  });

  it('resolves to the same bindings, not copies', () => {
    expect(shim.workingMemoryContext).toBe(context.workingMemoryContext);
    expect(shim.workingMemory).toBe(context.workingMemoryContext);
    expect(shim.Slot).toBe(context.Slot);
  });
});
