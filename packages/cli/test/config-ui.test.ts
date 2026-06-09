import { describe, expect, test } from 'bun:test';
import { AgentConfigSchema } from '../src/types/config.js';

const BASE = {
  model: 'm',
  cwd: '/tmp',
  apiKey: 'k',
  maxTurns: 1,
};

describe('AgentConfigSchema.ui.doublePressWindowMs', () => {
  test('accepts a valid window inside the documented range', () => {
    const parsed = AgentConfigSchema.parse({
      ...BASE,
      ui: {
        doublePressWindowMs: 500,
      },
    });
    expect(parsed.ui?.doublePressWindowMs).toBe(500);
  });

  test('omitted ui block parses successfully (option is optional)', () => {
    const parsed = AgentConfigSchema.parse(BASE);
    expect(parsed.ui).toBeUndefined();
  });

  test('omitted doublePressWindowMs inside ui parses successfully', () => {
    const parsed = AgentConfigSchema.parse({
      ...BASE,
      ui: {},
    });
    expect(parsed.ui?.doublePressWindowMs).toBeUndefined();
  });

  test('rejects non-integer values', () => {
    const result = AgentConfigSchema.safeParse({
      ...BASE,
      ui: {
        doublePressWindowMs: 500.5,
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects values below the minimum', () => {
    const result = AgentConfigSchema.safeParse({
      ...BASE,
      ui: {
        doublePressWindowMs: 50,
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects values above the maximum', () => {
    const result = AgentConfigSchema.safeParse({
      ...BASE,
      ui: {
        doublePressWindowMs: 6000,
      },
    });
    expect(result.success).toBe(false);
  });

  test('boundary: 100 ms (min, inclusive) accepted', () => {
    const parsed = AgentConfigSchema.parse({
      ...BASE,
      ui: {
        doublePressWindowMs: 100,
      },
    });
    expect(parsed.ui?.doublePressWindowMs).toBe(100);
  });

  test('boundary: 5000 ms (max, inclusive) accepted', () => {
    const parsed = AgentConfigSchema.parse({
      ...BASE,
      ui: {
        doublePressWindowMs: 5000,
      },
    });
    expect(parsed.ui?.doublePressWindowMs).toBe(5000);
  });

  test('boundary: 99 ms rejected', () => {
    const result = AgentConfigSchema.safeParse({
      ...BASE,
      ui: {
        doublePressWindowMs: 99,
      },
    });
    expect(result.success).toBe(false);
  });

  test('boundary: 5001 ms rejected', () => {
    const result = AgentConfigSchema.safeParse({
      ...BASE,
      ui: {
        doublePressWindowMs: 5001,
      },
    });
    expect(result.success).toBe(false);
  });
});
