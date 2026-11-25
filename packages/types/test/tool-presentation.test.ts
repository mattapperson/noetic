import { describe, expect, it } from 'bun:test';
import type { Tool, ToolCallProgress } from '../src/index';
import {
  clampProgress,
  frameworkCast,
  presentToolCall,
  presentToolContent,
  presentToolProgress,
} from '../src/index';

type Presentable = Pick<Tool, 'presentation' | 'acp'>;

const DECLARED: Presentable = {
  presentation: {
    kind: 'edit',
    title: (args: { path: string }) => `Write ${args.path}`,
    locations: (args: { path: string }) => [
      args.path,
      {
        path: 'b.ts',
        line: 2,
      },
    ],
    progress: (events: number[]) =>
      events.length > 1
        ? {
            progress: events.length * 25,
            locations: [
              {
                path: 'c.ts',
              },
            ],
          }
        : null,
    content: (output: { after: string }) => [
      {
        type: 'diff',
        path: 'a.ts',
        oldText: null,
        newText: output.after,
      },
    ],
  },
};

const THROWING: Presentable = {
  presentation: {
    title: () => {
      throw new Error('no title');
    },
    locations: () => {
      throw new Error('no locations');
    },
    progress: () => {
      throw new Error('no progress');
    },
    content: () => {
      throw new Error('no content');
    },
  },
};

describe('presentToolCall', () => {
  it('resolves the title, kind and locations a tool declares', () => {
    expect(
      presentToolCall(DECLARED, {
        path: 'a.ts',
      }),
    ).toEqual({
      kind: 'edit',
      title: 'Write a.ts',
      locations: [
        {
          path: 'a.ts',
        },
        {
          path: 'b.ts',
          line: 2,
        },
      ],
    });
  });

  it('gives the kind only before the arguments are known', () => {
    expect(presentToolCall(DECLARED, undefined)).toEqual({
      kind: 'edit',
    });
  });

  it('presents nothing for an undeclared tool, or for a declaration that throws', () => {
    expect(presentToolCall(undefined, {})).toEqual({});
    expect(presentToolCall({}, {})).toEqual({});
    expect(presentToolCall(THROWING, {})).toEqual({});
  });

  it('reads the deprecated acp declaration when there is no presentation', () => {
    expect(
      presentToolCall(
        {
          acp: {
            kind: 'read',
            title: 'Read',
            locations: () => [
              'x.ts',
            ],
          },
        },
        {},
      ),
    ).toEqual({
      kind: 'read',
      title: 'Read',
      locations: [
        {
          path: 'x.ts',
        },
      ],
    });
  });

  it('leaves out an empty title and empty locations', () => {
    expect(
      presentToolCall(
        {
          presentation: {
            title: () => '',
            locations: () => [],
          },
        },
        {},
      ),
    ).toEqual({});
  });
});

describe('presentToolProgress', () => {
  it('reports what the tool declares for the events so far, as a fraction', () => {
    expect(
      presentToolProgress(
        DECLARED,
        [
          1,
          2,
        ],
      ),
    ).toEqual({
      progress: 0.5,
      locations: [
        {
          path: 'c.ts',
        },
      ],
    });
  });

  it('reports nothing when the tool declares none, gives none, or throws', () => {
    expect(
      presentToolProgress(
        undefined,
        [
          1,
        ],
      ),
    ).toBeUndefined();
    expect(
      presentToolProgress(
        DECLARED,
        [
          1,
        ],
      ),
    ).toBeUndefined();
    expect(
      presentToolProgress(
        THROWING,
        [
          1,
        ],
      ),
    ).toBeUndefined();
  });
});

describe('presentToolProgress never fails a call', () => {
  it('reads a frozen report without writing to it', () => {
    const report = Object.freeze({
      progress: 50,
      locations: Object.freeze([
        'a.ts',
      ]),
    });
    const tool: Presentable = {
      presentation: {
        progress: () => frameworkCast<ToolCallProgress>(report),
      },
    };
    expect(
      presentToolProgress(
        tool,
        [
          1,
        ],
      ),
    ).toEqual({
      progress: 0.5,
      locations: [
        {
          path: 'a.ts',
        },
      ],
    });
    expect(report.progress).toBe(50);
  });

  it('reports nothing for a report it cannot read', () => {
    const tool: Presentable = {
      presentation: {
        progress: () =>
          frameworkCast<ToolCallProgress>({
            locations: 'not-a-list',
          }),
      },
    };
    expect(
      presentToolProgress(
        tool,
        [
          1,
        ],
      ),
    ).toBeUndefined();
  });
});

describe('presentToolContent', () => {
  it('gives the structured content a tool declares for its output', () => {
    expect(
      presentToolContent(
        DECLARED,
        {
          after: 'new',
        },
        {},
      ),
    ).toEqual([
      {
        type: 'diff',
        path: 'a.ts',
        oldText: null,
        newText: 'new',
      },
    ]);
  });

  it('gives nothing when the tool declares none, gives none, or throws', () => {
    expect(presentToolContent(undefined, {}, {})).toBeUndefined();
    expect(
      presentToolContent(
        {
          presentation: {
            content: () => [],
          },
        },
        {},
        {},
      ),
    ).toBeUndefined();
    expect(presentToolContent(THROWING, {}, {})).toBeUndefined();
  });
});

describe('clampProgress', () => {
  it.each([
    [
      0,
      0,
    ],
    [
      0.4,
      0.4,
    ],
    [
      1,
      1,
    ],
    [
      1.5,
      0.015,
    ],
    [
      50,
      0.5,
    ],
    [
      250,
      1,
    ],
    [
      -1,
      0,
    ],
  ])('reads %p as %p', (value, expected) => {
    expect(clampProgress(value)).toBeCloseTo(expected);
  });

  it('is undefined for anything but a finite number', () => {
    expect(clampProgress('1')).toBeUndefined();
    expect(clampProgress(Number.NaN)).toBeUndefined();
    expect(clampProgress(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
