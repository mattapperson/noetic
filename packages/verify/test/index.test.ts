import { describe, expect, it } from 'bun:test';
import { VERIFICATION_RUN_ITEM_TYPE } from '../src/index';

describe('@noetic-tools/verify', () => {
  it('re-exports the verification run item type', () => {
    expect(VERIFICATION_RUN_ITEM_TYPE).toBe('noetic:verification_run');
  });
});
