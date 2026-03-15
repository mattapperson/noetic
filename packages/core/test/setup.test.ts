import { describe, it, expect } from 'bun:test';

describe('setup', () => {
  it('can import from @orchid/core', async () => {
    const mod = await import('../src/index');
    expect(mod).toBeDefined();
  });

  it('bun test runner works', () => {
    expect(1 + 1).toBe(2);
  });
});
