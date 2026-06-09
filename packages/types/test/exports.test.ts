import { describe, expect, it } from 'bun:test';
import * as types from '../src/index';
import * as contract from '../src/types/memory';

describe('@noetic-tools/types public surface', () => {
  it('exports the Slot runtime constant from the contract', () => {
    expect(contract.Slot).toBeDefined();
    expect(typeof contract.Slot).toBe('object');
  });

  it('re-exports the contract through the main barrel', () => {
    expect(types.Slot).toBe(contract.Slot);
  });

  it('exports the NoeticError implementation class', () => {
    expect(types.NoeticErrorImpl).toBeDefined();
    expect(typeof types.NoeticErrorImpl).toBe('function');
  });
});
