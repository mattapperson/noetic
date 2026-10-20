import { describe, expect, it } from 'bun:test';
import { toJson } from '../server/sse';

describe('toJson', () => {
  it('encodes Map values (the filesystem layer state shape)', () => {
    const value = {
      files: new Map([
        [
          'a.ts',
          {
            tokens: 3,
          },
        ],
      ]),
    };
    expect(JSON.parse(toJson(value))).toEqual({
      files: {
        __type: 'Map',
        entries: [
          [
            'a.ts',
            {
              tokens: 3,
            },
          ],
        ],
      },
    });
  });

  it('encodes Set values', () => {
    expect(
      JSON.parse(
        toJson(
          new Set([
            'x',
            'y',
          ]),
        ),
      ),
    ).toEqual({
      __type: 'Set',
      values: [
        'x',
        'y',
      ],
    });
  });

  it('encodes bigint as string', () => {
    expect(
      JSON.parse(
        toJson({
          n: 10n,
        }),
      ),
    ).toEqual({
      n: '10',
    });
  });

  it('leaves plain JSON untouched', () => {
    const value = {
      a: 1,
      b: [
        true,
        null,
        'text',
      ],
    };
    expect(JSON.parse(toJson(value))).toEqual(value);
  });
});
