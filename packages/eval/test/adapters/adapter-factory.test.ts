import { afterEach, describe, expect, test } from 'bun:test';

import {
  clearRegisteredFields,
  createAdapter,
  getRegisteredFields,
} from '../../src/adapters/adapter-factory';

afterEach(() => {
  clearRegisteredFields();
});

//#region Helper Functions

/** Parse the file/line of the frame that calls this function (frame [2]: Error, hereLocation, caller). */
function hereLocation(): {
  filePath: string;
  line: number;
} {
  const stack = new Error().stack ?? '';
  const lines = stack.split('\n');
  const frame = lines[2];
  const match = frame.match(/\((.+):(\d+):(\d+)\)/) ?? frame.match(/at (.+):(\d+):(\d+)/);
  if (!match) {
    throw new Error(`unparseable stack frame: ${frame}`);
  }
  return {
    filePath: match[1],
    line: Number.parseInt(match[2], 10),
  };
}

function makeAdapter(): Record<string, (...args: unknown[]) => unknown> {
  return createAdapter({
    provider: 'custom',
    wrap: {
      generate: (...args: unknown[]) => args[0],
    },
    fields: {
      generate: {
        '0.prompt': 'prompt',
      },
    },
  });
}

//#endregion

describe('createAdapter source-location capture', () => {
  test('records the CALLER frame (file and line of the wrapped call site)', () => {
    const adapter = makeAdapter();

    const here = hereLocation();
    adapter.generate({
      prompt: 'hello world',
    }); // must be on the line directly after hereLocation()

    const fields = getRegisteredFields();
    expect(fields).toHaveLength(1);
    const field = fields[0];
    expect(field.value).toBe('hello world');
    expect(field.sourceLocation).toBeDefined();
    if (!field.sourceLocation) {
      throw new Error('sourceLocation missing');
    }
    expect(field.sourceLocation.filePath).toBe(here.filePath);
    expect(field.sourceLocation.line).toBe(here.line + 1);
  });

  test('registers field values from mapped paths', () => {
    const adapter = makeAdapter();
    adapter.generate({
      prompt: 'first',
    });
    adapter.generate({
      prompt: 'second',
    });

    const values = getRegisteredFields().map((f) => f.value);
    expect(values).toEqual([
      'first',
      'second',
    ]);
  });

  test('clearRegisteredFields empties the registry', () => {
    const adapter = makeAdapter();
    adapter.generate({
      prompt: 'transient',
    });
    expect(getRegisteredFields()).toHaveLength(1);

    clearRegisteredFields();
    expect(getRegisteredFields()).toHaveLength(0);
  });

  test('wrapped function still forwards arguments and returns its result', () => {
    const adapter = makeAdapter();
    const result = adapter.generate({
      prompt: 'passthrough',
    });
    expect(result).toEqual({
      prompt: 'passthrough',
    });
  });

  test('non-string mapped values are skipped', () => {
    const adapter = makeAdapter();
    adapter.generate({
      prompt: 42,
    });
    expect(getRegisteredFields()).toHaveLength(0);
  });
});
