import { describe, expect, it } from 'bun:test';

import { resolveBinaryStatuses } from '../src/setup/resolver.js';
import type { AgentConfig } from '../src/types/config.js';
import type { BinaryDescriptor } from '../src/setup/types.js';

function makeConfig(ignored: ReadonlyArray<string> = []): AgentConfig {
  return {
    model: 'test',
    cwd: '/tmp',
    apiKey: 'k',
    maxTurns: 1,
    setup: {
      ignoredBinaries: [
        ...ignored,
      ],
    },
  };
}

function makeDescriptor(
  id: 'rtk' | 'pilotty' | 'agent-browser',
  present: boolean,
): BinaryDescriptor {
  return {
    id,
    displayName: id,
    summary: '',
    kind: 'path',
    detect: async () => present,
    installOptionsFor: () => [],
    manualInstructionsFor: () => '',
    affects: [],
  };
}

describe('resolveBinaryStatuses', () => {
  it('reports ignored without calling the detector', async () => {
    let detectorCalled = false;
    const descriptor: BinaryDescriptor = {
      id: 'rtk',
      displayName: 'rtk',
      summary: '',
      kind: 'path',
      detect: async () => {
        detectorCalled = true;
        return true;
      },
      installOptionsFor: () => [],
      manualInstructionsFor: () => '',
      affects: [],
    };
    const result = await resolveBinaryStatuses(makeConfig(['rtk']), [
      descriptor,
    ]);
    expect(result).toEqual([
      {
        id: 'rtk',
        state: 'ignored',
      },
    ]);
    expect(detectorCalled).toBe(false);
  });

  it('reports present when detector returns true', async () => {
    const result = await resolveBinaryStatuses(makeConfig(), [
      makeDescriptor('pilotty', true),
    ]);
    expect(result).toEqual([
      {
        id: 'pilotty',
        state: 'present',
      },
    ]);
  });

  it('reports missing when detector returns false', async () => {
    const result = await resolveBinaryStatuses(makeConfig(), [
      makeDescriptor('agent-browser', false),
    ]);
    expect(result).toEqual([
      {
        id: 'agent-browser',
        state: 'missing',
      },
    ]);
  });

  it('handles mixed ignored / present / missing in one call', async () => {
    const result = await resolveBinaryStatuses(makeConfig(['rtk']), [
      makeDescriptor('rtk', true),
      makeDescriptor('pilotty', true),
      makeDescriptor('agent-browser', false),
    ]);
    expect(result).toEqual([
      {
        id: 'rtk',
        state: 'ignored',
      },
      {
        id: 'pilotty',
        state: 'present',
      },
      {
        id: 'agent-browser',
        state: 'missing',
      },
    ]);
  });

  it('ignores unknown ids in the config silently', async () => {
    const result = await resolveBinaryStatuses(makeConfig(['definitely-not-a-binary']), [
      makeDescriptor('rtk', true),
    ]);
    expect(result).toEqual([
      {
        id: 'rtk',
        state: 'present',
      },
    ]);
  });
});
