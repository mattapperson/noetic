import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { NoeticConfigError } from '../src/errors/noetic-config-error';
import type { AdapterConfig } from '../src/types/adapter-set';
import { adapterSet, DEFAULT_ADAPTER_NAME } from '../src/types/adapter-set';
import { frameworkCast } from '../src/util/framework-cast';

interface Shell {
  exec(command: string): string;
}

function shell(host: string): Shell {
  return {
    exec: (command) => `${host}: ${command}`,
  };
}

function shells(config: unknown): ReturnType<typeof adapterSet<Shell>> {
  return adapterSet<Shell>({
    kind: 'shell',
    method: 'exec',
    // What a JavaScript caller, or a config file, can hand over.
    config: frameworkCast<AdapterConfig<Shell>>(config),
  });
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    assert(e instanceof NoeticConfigError);
    return e.code;
  }
  expect.unreachable('expected a NoeticConfigError');
  return '';
}

describe('adapterSet — one adapter', () => {
  it("goes by 'default' and is the default", () => {
    const only = shell('here');
    const set = shells(only);
    expect(DEFAULT_ADAPTER_NAME).toBe('default');
    expect(set.get()).toBe(only);
    expect(set.get('default')).toBe(only);
    expect(set.list()).toEqual([
      {
        name: 'default',
        default: true,
      },
    ]);
  });

  it('takes an adapter whose methods sit on its prototype', () => {
    class RemoteShell implements Shell {
      exec(command: string): string {
        return command;
      }
    }
    const only = new RemoteShell();
    expect(shells(only).get()).toBe(only);
  });
});

describe('adapterSet — several by name', () => {
  it('returns the marked default for no name, and each by its name', () => {
    const laptop = shell('laptop');
    const builder = shell('builder');
    const set = shells({
      laptop: {
        adapter: laptop,
        default: true,
      },
      builder: {
        adapter: builder,
        displayName: 'Build host',
        description: 'Linux, 64 cores',
      },
    });
    expect(set.get()).toBe(laptop);
    expect(set.get('laptop')).toBe(laptop);
    expect(set.get('builder')).toBe(builder);
    expect(set.list()).toEqual([
      {
        name: 'laptop',
        default: true,
      },
      {
        name: 'builder',
        displayName: 'Build host',
        description: 'Linux, 64 cores',
        default: false,
      },
    ]);
  });

  it('needs no mark on a set of one', () => {
    const only = shell('builder');
    const set = shells({
      builder: {
        adapter: only,
      },
    });
    expect(set.get()).toBe(only);
    expect(set.list()).toEqual([
      {
        name: 'builder',
        default: true,
      },
    ]);
  });

  it('reads an entry named like the adapter method as an entry', () => {
    const only = shell('exec');
    const set = shells({
      exec: {
        adapter: only,
      },
    });
    expect(set.get('exec')).toBe(only);
  });

  it('fails several with none marked default', () => {
    expect(
      codeOf(() =>
        shells({
          laptop: {
            adapter: shell('laptop'),
          },
          builder: {
            adapter: shell('builder'),
          },
        }),
      ),
    ).toBe('ADAPTER_DEFAULT_MISSING');
  });

  it('fails more than one marked default', () => {
    expect(
      codeOf(() =>
        shells({
          laptop: {
            adapter: shell('laptop'),
            default: true,
          },
          builder: {
            adapter: shell('builder'),
            default: true,
          },
        }),
      ),
    ).toBe('ADAPTER_DEFAULT_AMBIGUOUS');
  });

  it('fails an empty set', () => {
    expect(codeOf(() => shells({}))).toBe('ADAPTER_SET_EMPTY');
  });

  it('fails a value that is neither an adapter nor a set', () => {
    class NotAShell {
      run(): void {}
    }
    for (const config of [
      new NotAShell(),
      [
        shell('listed'),
      ],
      'laptop',
      null,
    ]) {
      expect(codeOf(() => shells(config))).toBe('ADAPTER_INVALID');
    }
  });

  it('fails an entry with no adapter', () => {
    for (const entry of [
      {},
      {
        adapter: {},
      },
      shell('bare'),
      'laptop',
    ]) {
      expect(
        codeOf(() =>
          shells({
            laptop: entry,
          }),
        ),
      ).toBe('ADAPTER_INVALID');
    }
  });

  it('fails an unknown name, listing the names it has', () => {
    const set = shells({
      laptop: {
        adapter: shell('laptop'),
        default: true,
      },
      builder: {
        adapter: shell('builder'),
      },
    });
    try {
      set.get('cloud');
      expect.unreachable('expected ADAPTER_UNKNOWN');
    } catch (e) {
      assert(e instanceof NoeticConfigError);
      expect(e.code).toBe('ADAPTER_UNKNOWN');
      expect(e.message).toContain("'cloud'");
      expect(e.message).toContain("'laptop', 'builder'");
    }
  });
});

describe('adapterSet — the listing', () => {
  it('cannot be changed by a caller', () => {
    const laptop = shell('laptop');
    const set = shells({
      laptop: {
        adapter: laptop,
        default: true,
      },
      builder: {
        adapter: shell('builder'),
      },
    });
    const listing = frameworkCast<
      Array<{
        name: string;
        default: boolean;
      }>
    >(set.list());
    expect(() => {
      listing[0].default = false;
    }).toThrow(TypeError);
    expect(() =>
      listing.push({
        name: 'cloud',
        default: true,
      }),
    ).toThrow(TypeError);
    expect(set.list().map((adapter) => adapter.default)).toEqual([
      true,
      false,
    ]);
    expect(set.get()).toBe(laptop);
    expect(set.defaultName).toBe('laptop');
  });
});

describe('adapterSet — telling an adapter from a set', () => {
  it('fails a value that is both an adapter and a set', () => {
    expect(
      codeOf(() =>
        shells({
          exec: () => 'here',
          local: {
            adapter: shell('local'),
            default: true,
          },
        }),
      ),
    ).toBe('ADAPTER_INVALID');
  });

  it('takes an adapter that carries plain data of its own', () => {
    const only = {
      ...shell('here'),
      options: {
        timeoutMs: 5,
      },
    };
    expect(shells(only).get()).toBe(only);
  });

  it('fails a lone entry marked not the default', () => {
    expect(
      codeOf(() =>
        shells({
          laptop: {
            adapter: shell('laptop'),
            default: false,
          },
        }),
      ),
    ).toBe('ADAPTER_DEFAULT_MISSING');
  });

  it("fails an entry named 'default' that is not the default", () => {
    expect(
      codeOf(() =>
        shells({
          default: {
            adapter: shell('a'),
          },
          builder: {
            adapter: shell('b'),
            default: true,
          },
        }),
      ),
    ).toBe('ADAPTER_INVALID');
  });

  it("takes an entry named 'default' that is the default", () => {
    const a = shell('a');
    const set = shells({
      default: {
        adapter: a,
        default: true,
      },
      builder: {
        adapter: shell('b'),
      },
    });
    expect(set.get('default')).toBe(set.get());
    expect(set.get()).toBe(a);
    expect(set.defaultName).toBe('default');
  });
});
