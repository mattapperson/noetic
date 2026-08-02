import { describe, expect, it } from 'bun:test';
import * as context from '../src/index';

describe('@noetic-tools/context public surface', () => {
  it('exports built-in layer factories', () => {
    expect(typeof context.workingMemoryContext).toBe('function');
    expect(typeof context.historyWindow).toBe('function');
    expect(typeof context.planContext).toBe('function');
    expect(typeof context.toolContextLayer).toBe('function');
  });

  it('re-exports the ContextLayer contract (Slot) from @noetic-tools/types', () => {
    expect(context.Slot).toBeDefined();
    expect(context.Slot.WORKING_MEMORY).toBe(100);
  });

  it('exports the budget allocation utilities', () => {
    expect(typeof context.allocateBudgets).toBe('function');
    expect(typeof context.checkBudget).toBe('function');
  });
});

describe('deprecated aliases', () => {
  it('resolves every renamed layer factory to its replacement', () => {
    expect(context.workingMemory).toBe(context.workingMemoryContext);
    expect(context.observationalMemory).toBe(context.observationalContext);
    expect(context.temporalMemory).toBe(context.temporalContext);
    expect(context.planMemory).toBe(context.planContext);
    expect(context.toolMemoryLayer).toBe(context.toolContextLayer);
    expect(context.buildContextMemory).toBe(context.buildContextData);
  });
});

describe('built-in layer ids', () => {
  it('uses the context vocabulary for the renamed layers', () => {
    expect(context.workingMemoryContext().id).toBe('working-context');
    expect(
      context.observationalContext({
        observer: async () => [],
      }).id,
    ).toBe('observational-context');
  });
});
