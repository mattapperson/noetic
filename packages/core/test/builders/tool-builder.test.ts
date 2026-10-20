import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { tool, toolWithGenerator } from '../../src/builders/tool-builder';

const Input = z.object({
  carrier: z.string().optional(),
});
const Output = z.object({
  price: z.number(),
});
const Progress = z.object({
  pct: z.number(),
});

describe('tool()', () => {
  it('produces a Tool with the configured schemas and execute', () => {
    const t = tool({
      name: 'quote',
      description: 'Quote a price',
      input: Input,
      output: Output,
      execute: async () => ({
        price: 1,
      }),
    });
    expect(t.name).toBe('quote');
    expect(t.input).toBe(Input);
    expect(t.output).toBe(Output);
    expect(t.ui).toBeUndefined();
  });

  it('forwards a ui declaration onto the Tool', () => {
    const t = tool({
      name: 'quote',
      description: 'Quote a price',
      input: Input,
      output: Output,
      execute: async () => ({
        price: 1,
      }),
      ui: {
        call: (args) => ({
          dialect: 'openui',
          source: `Text("${args.carrier ?? '…'}")`,
        }),
        result: (out) => ({
          dialect: 'openui',
          source: `Text("${out.price}")`,
        }),
      },
    });
    assert(t.ui !== undefined);
    assert(t.ui.call !== undefined);
    expect(
      t.ui.call({
        carrier: 'ups',
      }),
    ).toEqual({
      dialect: 'openui',
      source: 'Text("ups")',
    });
  });

  it('throws EMPTY_TOOL_NAME for a blank name', () => {
    try {
      tool({
        name: '  ',
        description: 'x',
        input: Input,
        output: Output,
        execute: async () => ({
          price: 1,
        }),
      });
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('EMPTY_TOOL_NAME');
    }
  });

  it('throws MISSING_EXECUTE_FUNCTION when execute is absent', () => {
    try {
      // @ts-expect-error — omitting `execute` is the runtime guard under test
      tool({
        name: 'quote',
        description: 'x',
        input: Input,
        output: Output,
      });
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_EXECUTE_FUNCTION');
    }
  });
});

describe('toolWithGenerator()', () => {
  it('forwards the ui declaration and types progress from the event schema', () => {
    const t = toolWithGenerator({
      name: 'quote',
      description: 'Quote a price',
      input: Input,
      output: Output,
      event: Progress,
      ui: {
        // `events` is inferred as { pct: number }[] from `event` — a plain
        // arithmetic use here fails to compile if that inference regresses.
        progress: (events) => ({
          dialect: 'openui',
          source: `Progress(${(events.at(-1)?.pct ?? 0) + 0})`,
        }),
      },
      async *execute() {
        yield {
          pct: 40,
        };
        return {
          price: 2,
        };
      },
    });
    assert(t.ui !== undefined);
    assert(t.ui.progress !== undefined);
    expect(
      t.ui.progress([
        {
          pct: 40,
        },
      ]),
    ).toEqual({
      dialect: 'openui',
      source: 'Progress(40)',
    });
    expect(t.event).toBe(Progress);
  });

  it('omits ui when the config does not declare one', () => {
    const t = toolWithGenerator({
      name: 'quote',
      description: 'Quote a price',
      input: Input,
      output: Output,
      event: Progress,
      async *execute() {
        yield {
          pct: 1,
        };
        return {
          price: 2,
        };
      },
    });
    expect(t.ui).toBeUndefined();
  });
});

describe('ToolAcpDeclaration passthrough', () => {
  it('tool() carries the acp declaration onto the Tool', () => {
    const t = tool({
      name: 'edit_file',
      description: 'Edit a file',
      input: z.object({
        path: z.string(),
      }),
      output: Output,
      execute: async () => ({
        price: 1,
      }),
      acp: {
        kind: 'edit',
        title: (args) => `Edit ${args.path}`,
        locations: (args) => [
          args.path,
        ],
      },
    });
    assert(t.acp);
    expect(t.acp.kind).toBe('edit');
    assert(typeof t.acp.title === 'function');
    expect(
      t.acp.title({
        path: '/tmp/a.ts',
      }),
    ).toBe('Edit /tmp/a.ts');
    assert(t.acp.locations);
    expect(
      t.acp.locations({
        path: '/tmp/a.ts',
      }),
    ).toEqual([
      '/tmp/a.ts',
    ]);
  });

  it('toolWithGenerator() carries the acp declaration onto the Tool', () => {
    const t = toolWithGenerator({
      name: 'run_build',
      description: 'Run the build',
      input: Input,
      output: Output,
      event: Progress,
      async *execute() {
        yield {
          pct: 1,
        };
        return {
          price: 2,
        };
      },
      acp: {
        kind: 'execute',
        title: 'Run the build',
      },
    });
    assert(t.acp);
    expect(t.acp.kind).toBe('execute');
    expect(t.acp.title).toBe('Run the build');
  });

  it('omits acp when the config does not declare one', () => {
    const t = tool({
      name: 'quote',
      description: 'Quote a price',
      input: Input,
      output: Output,
      execute: async () => ({
        price: 1,
      }),
    });
    expect(t.acp).toBeUndefined();
  });
});
