import { describe, expect, it } from 'bun:test';

import { BINARY_MANIFEST } from '../src/setup/binary-manifest.js';
import type { BinaryId } from '../src/setup/types.js';

function descriptorFor(id: BinaryId) {
  const descriptor = BINARY_MANIFEST.find((d) => d.id === id);
  expect(descriptor).toBeDefined();
  if (!descriptor) {
    throw new Error('unreachable');
  }
  return descriptor;
}

describe('BINARY_MANIFEST.installOptionsFor — rtk', () => {
  it('offers brew on macOS when brew is detected', () => {
    const options = descriptorFor('rtk').installOptionsFor('macos', [
      'brew',
      'curl',
    ]);
    expect(options.map((o) => o.label)).toContain('Homebrew');
  });

  it('never offers brew when brew is not detected', () => {
    const options = descriptorFor('rtk').installOptionsFor('macos', [
      'curl',
      'cargo',
    ]);
    expect(options.map((o) => o.label)).not.toContain('Homebrew');
  });

  it('offers curl script on Linux as a fallback', () => {
    const options = descriptorFor('rtk').installOptionsFor('linux', [
      'curl',
    ]);
    expect(options.map((o) => o.label)).toContain('curl install script');
  });

  it('returns no options on Windows (manual-only)', () => {
    const options = descriptorFor('rtk').installOptionsFor('windows', [
      'winget',
      'scoop',
    ]);
    expect(options).toEqual([]);
  });
});

describe('BINARY_MANIFEST.installOptionsFor — pilotty', () => {
  it('offers `bun install` when bun is available', () => {
    const options = descriptorFor('pilotty').installOptionsFor('macos', [
      'bun',
    ]);
    expect(options.length).toBe(1);
    expect(options[0].command).toBe('bun');
    expect(options[0].args).toEqual([
      'install',
    ]);
  });

  it('returns no options without bun', () => {
    const options = descriptorFor('pilotty').installOptionsFor('macos', [
      'brew',
    ]);
    expect(options).toEqual([]);
  });
});

describe('BINARY_MANIFEST.installOptionsFor — agent-browser', () => {
  it('offers bun install + bunx agent-browser install when both are detected', () => {
    const options = descriptorFor('agent-browser').installOptionsFor('macos', [
      'bun',
      'bunx',
    ]);
    expect(options.map((o) => o.label)).toEqual([
      'bun install (workspace)',
      'bunx agent-browser install (download Chrome)',
    ]);
  });
});

describe('BINARY_MANIFEST.manualInstructionsFor', () => {
  it('returns OS-specific instructions for rtk on macOS', () => {
    const text = descriptorFor('rtk').manualInstructionsFor('macos');
    expect(text).toContain('brew install rtk-ai/tap/rtk');
  });

  it('returns OS-specific instructions for rtk on Linux', () => {
    const text = descriptorFor('rtk').manualInstructionsFor('linux');
    expect(text).toContain('install.sh');
  });

  it('returns Windows-friendly instructions for rtk', () => {
    const text = descriptorFor('rtk').manualInstructionsFor('windows');
    expect(text).toContain('Windows');
  });
});
