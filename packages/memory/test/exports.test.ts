import { describe, expect, it } from 'bun:test';
import * as memory from '../src/index';

describe('@noetic-tools/memory public surface', () => {
  it('exports built-in layer factories', () => {
    expect(typeof memory.workingMemory).toBe('function');
    expect(typeof memory.historyWindow).toBe('function');
    expect(typeof memory.planMemory).toBe('function');
    expect(typeof memory.toolMemoryLayer).toBe('function');
  });

  it('re-exports the MemoryLayer contract (Slot) from @noetic-tools/types', () => {
    expect(memory.Slot).toBeDefined();
    expect(memory.Slot.WORKING_MEMORY).toBe(100);
  });

  it('exports the budget allocation utilities', () => {
    expect(typeof memory.allocateBudgets).toBe('function');
    expect(typeof memory.checkBudget).toBe('function');
  });
});
