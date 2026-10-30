import { describe, expect, it } from 'bun:test';
import { checkConformance } from '../src/conformance';
import { mcp, PROFILES_CAPABILITY } from '../src/index';

describe('@noetic-tools/mcp entry points', () => {
  it('exports mcp(), the profiles capability key, and the conformance runner', () => {
    expect(PROFILES_CAPABILITY).toBe('tools.noetic/profiles');
    expect(typeof mcp).toBe('function');
    expect(typeof checkConformance).toBe('function');
  });
});
