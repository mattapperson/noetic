import { describe, expect, it } from 'bun:test';
import type { ConnectionProvider } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type { Verifier } from '@noetic-tools/types/verify';
import { AgentHarness } from '../../src';
import { harnessInternal, setHarnessInternals } from '../../src/util/harness-internals';

//#region Helpers

const provider: ConnectionProvider = {
  connect: async () => [],
};

//#endregion

describe('harness internals', () => {
  it('reads back the slots a harness was given, merged across calls', () => {
    const harness = {};
    const registry = {
      names: (): ReadonlyArray<string> => [],
    };
    setHarnessInternals(harness, {
      connectionRegistry: registry,
    });
    setHarnessInternals(harness, {
      verifier: 'v',
    });
    expect(harnessInternal(harness, 'connectionRegistry')).toBe(registry);
    expect(harnessInternal<string>(harness, 'verifier')).toBe('v');
  });

  it('gives undefined for a non-object, an unknown harness and an unset slot', () => {
    expect(harnessInternal(undefined, 'verifier')).toBeUndefined();
    expect(harnessInternal(null, 'verifier')).toBeUndefined();
    expect(harnessInternal({}, 'verifier')).toBeUndefined();
    const harness = {};
    setHarnessInternals(harness, {
      verifier: 'v',
    });
    expect(harnessInternal(harness, 'connectionRegistry')).toBeUndefined();
  });

  it('a harness with connections, secrets and a verifier exposes none of them as properties', () => {
    const resolve = async (): Promise<string> => 'hunter2';
    const harness = new AgentHarness({
      name: 'sealed',
      params: {},
      connections: {
        app: provider,
      },
      environment: {
        secrets: {
          resolve,
        },
      },
      verification: frameworkCast<Verifier>({
        name: 'v',
      }),
    });
    const visible = new Set<string>();
    for (let target: object | null = harness; target; target = Object.getPrototypeOf(target)) {
      for (const key of Object.getOwnPropertyNames(target)) {
        visible.add(key);
      }
    }
    expect(visible.has('connectionRegistry')).toBe(false);
    expect(visible.has('secrets')).toBe(false);
    expect(visible.has('verifier')).toBe(false);
    expect(visible.has('connections')).toBe(false);
    expect(JSON.stringify(Object.values(harness))).not.toContain('hunter2');
    expect(harnessInternal(harness, 'connectionRegistry')).toBeDefined();
  });
});
