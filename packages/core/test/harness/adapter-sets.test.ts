/**
 * `environment.fs`, `shell` and `subprocess` each take one adapter or several
 * by name. The harness and every context hand out the default as before, and
 * all of them by name through `adapters`.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { contextToExecCtx } from '@noetic-tools/context';
import type { AdapterSets, ContextLayer, FsAdapter } from '@noetic-tools/types';
import { createMessage, isNoeticConfigError, Slot } from '@noetic-tools/types';
import { z } from 'zod';
import { createInMemoryFsAdapter } from '../../src/adapters/in-memory-fs-adapter';
import { createInMemoryShellAdapter } from '../../src/adapters/in-memory-shell-adapter';
import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import { invokeTool } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { AgentEnvironmentConfig } from '../../src/harness/harness-options';
import { buildToolExecutionContext } from '../../src/runtime/tool-context';

//#region Helpers

function harnessWith(environment?: AgentEnvironmentConfig): AgentHarness {
  return new AgentHarness({
    name: 'adapter-sets',
    params: {},
    environment,
  });
}

function twoFilesystems(): {
  laptop: FsAdapter;
  builder: FsAdapter;
  harness: AgentHarness;
} {
  const laptop = createInMemoryFsAdapter();
  const builder = createInMemoryFsAdapter();
  return {
    laptop,
    builder,
    harness: harnessWith({
      fs: {
        laptop: {
          adapter: laptop,
          default: true,
        },
        builder: {
          adapter: builder,
          displayName: 'Build host',
          description: 'Linux, 64 cores',
        },
      },
    }),
  };
}

function configCode(build: () => unknown): string {
  try {
    build();
  } catch (e) {
    assert(isNoeticConfigError(e));
    return e.code;
  }
  expect.unreachable('expected a NoeticConfigError');
  return '';
}

//#endregion

describe('one unnamed adapter', () => {
  it("is the default of its kind, by the name 'default'", () => {
    const fs = createInMemoryFsAdapter();
    const shell = createInMemoryShellAdapter();
    const subprocess = createInMemorySubprocessAdapter();
    const harness = harnessWith({
      fs,
      shell,
      subprocess,
    });
    expect(harness.fs).toBe(fs);
    expect(harness.shell).toBe(shell);
    expect(harness.subprocess).toBe(subprocess);
    expect(harness.adapters.fs.get()).toBe(fs);
    expect(harness.adapters.shell.get('default')).toBe(shell);
    expect(harness.adapters.subprocess.get('default')).toBe(subprocess);
    expect(harness.adapters.fs.list()).toEqual([
      {
        name: 'default',
        default: true,
      },
    ]);
  });

  it('is the in-memory one when the environment gives none', () => {
    const harness = harnessWith();
    for (const kind of [
      'fs',
      'shell',
      'subprocess',
    ] satisfies Array<keyof AdapterSets>) {
      expect(harness.adapters[kind].list()).toEqual([
        {
          name: 'default',
          default: true,
        },
      ]);
    }
    expect(harness.adapters.fs.get()).toBe(harness.fs);
  });
});

describe('several named adapters', () => {
  it('gives the default where none is named, and each by its name', () => {
    const { laptop, builder, harness } = twoFilesystems();
    const ctx = harness.createContext();
    expect(harness.fs).toBe(laptop);
    expect(ctx.fs).toBe(laptop);
    expect(ctx.adapters.fs.get()).toBe(laptop);
    expect(ctx.adapters.fs.get('builder')).toBe(builder);
    expect(harness.adapters.fs.get('builder')).toBe(builder);
    expect(ctx.adapters.fs.list()).toEqual([
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
    // The kinds left out keep one unnamed adapter.
    expect(ctx.adapters.shell.get('default')).toBe(ctx.shell);
    expect(ctx.adapters.subprocess.get('default')).toBe(ctx.subprocess);
  });

  it('names every kind independently', () => {
    const builderShell = createInMemoryShellAdapter();
    const builderProcesses = createInMemorySubprocessAdapter();
    const harness = harnessWith({
      shell: {
        builder: {
          adapter: builderShell,
        },
      },
      subprocess: {
        laptop: {
          adapter: createInMemorySubprocessAdapter(),
        },
        builder: {
          adapter: builderProcesses,
          default: true,
        },
      },
    });
    expect(harness.shell).toBe(builderShell);
    expect(harness.subprocess).toBe(builderProcesses);
    expect(harness.adapters.subprocess.get('laptop')).not.toBe(builderProcesses);
  });

  it('fails a name the set lacks, listing the names it has', () => {
    const { harness } = twoFilesystems();
    try {
      harness.createContext().adapters.fs.get('cloud');
      expect.unreachable('expected ADAPTER_UNKNOWN');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('ADAPTER_UNKNOWN');
      expect(e.message).toContain("'laptop', 'builder'");
    }
  });

  it('fails when the harness is built with no default among several', () => {
    expect(
      configCode(() =>
        harnessWith({
          fs: {
            laptop: {
              adapter: createInMemoryFsAdapter(),
            },
            builder: {
              adapter: createInMemoryFsAdapter(),
            },
          },
        }),
      ),
    ).toBe('ADAPTER_DEFAULT_MISSING');
  });

  it('fails when the harness is built with two defaults', () => {
    expect(
      configCode(() =>
        harnessWith({
          shell: {
            laptop: {
              adapter: createInMemoryShellAdapter(),
              default: true,
            },
            builder: {
              adapter: createInMemoryShellAdapter(),
              default: true,
            },
          },
        }),
      ),
    ).toBe('ADAPTER_DEFAULT_AMBIGUOUS');
  });

  it('fails when the harness is built with an empty set', () => {
    expect(
      configCode(() =>
        harnessWith({
          subprocess: {},
        }),
      ),
    ).toBe('ADAPTER_SET_EMPTY');
  });
});

describe('tools and layers', () => {
  it('hands a tool every adapter through its tool context', async () => {
    const { builder, harness } = twoFilesystems();
    await builder.writeFile('/notes.txt', 'on the build host');
    const read = tool({
      name: 'read_on',
      description: 'Read a file on a named filesystem',
      input: z.object({
        on: z.string(),
        path: z.string(),
      }),
      output: z.object({
        text: z.string(),
      }),
      execute: async (args, toolCtx) => ({
        text: await toolCtx.adapters.fs.get(args.on).readFileText(args.path),
      }),
    });
    const output = await harness.run(
      invokeTool({
        id: 'read',
        tool: read,
      }),
      {
        on: 'builder',
        path: '/notes.txt',
      },
      harness.createContext(),
    );
    expect(output).toEqual({
      text: 'on the build host',
    });
  });

  it("builds a tool context and a layer context with the harness's sets", () => {
    const { laptop, harness } = twoFilesystems();
    const ctx = harness.createContext();
    const toolCtx = buildToolExecutionContext(ctx, harness);
    expect(toolCtx.fs).toBe(laptop);
    expect(toolCtx.adapters).toBe(harness.adapters);
    const execCtx = contextToExecCtx(ctx);
    expect(execCtx.fs).toBe(laptop);
    expect(execCtx.adapters).toBe(harness.adapters);
  });

  it('guards every named adapter in a context preview', async () => {
    const builder = createInMemoryFsAdapter({
      '/notes.txt': 'kept',
    });
    const refused: string[] = [];
    const layer: ContextLayer = {
      id: 'writer',
      slot: Slot.RAG,
      scope: 'thread',
      hooks: {
        recall: async ({ ctx }) => {
          const fs = ctx.adapters.fs.get('builder');
          const text = await fs.readFileText('/notes.txt');
          await fs.writeFile('/notes.txt', 'overwritten').catch(() => refused.push('fs'));
          await ctx.adapters.shell
            .get()
            .exec('touch /x', {
              cwd: '/',
            })
            .catch(() => refused.push('shell'));
          await ctx.adapters.subprocess
            .get()
            .spawn({
              command: 'touch',
            })
            .catch(() => refused.push('subprocess'));
          return {
            items: [
              createMessage(text, 'developer'),
            ],
            tokenCount: 1,
          };
        },
      },
    };
    const preview = await new AgentHarness({
      name: 'adapter-sets-preview',
      params: {},
      environment: {
        fs: {
          laptop: {
            adapter: createInMemoryFsAdapter(),
            default: true,
          },
          builder: {
            adapter: builder,
          },
        },
      },
      contextLayers: [
        layer,
      ],
    }).getCurrentContext(true);
    expect(preview?.status).toBe('preview');
    expect(refused).toEqual([
      'fs',
      'shell',
      'subprocess',
    ]);
    expect(await builder.readFileText('/notes.txt')).toBe('kept');
  });
});
