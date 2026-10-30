import { describe, expect, test } from 'bun:test';
import type { ConnectionManifest, ConnectionMissing } from '@noetic-tools/types';
import {
  defineExtension,
  defineProfile,
  isConnectionUnsatisfiedError,
  isNoeticConfigError,
  isNoeticError,
  RefSchema,
  receipt,
  ref,
} from '@noetic-tools/types';
import { z } from 'zod';
import {
  resumeDecision,
  sameInstance,
  stepIdempotencyKey,
  toolIdempotencyKey,
} from '../../src/connections/durability';
import { connection, handleTarget, isConnectionHandle } from '../../src/connections/handle';
import { checkRequirement, requirementFor } from '../../src/connections/negotiation';
import type { RefScope } from '../../src/connections/refs';
import { kindInfoFrom, RefSealer, refConnections, refKindsOf } from '../../src/connections/refs';
import { makeStorage } from '../_helpers';

//#region Fixtures

const ui = defineProfile({
  name: 'ui',
  version: '1.1.0',
  operations: {
    'ui.tap': {
      description: 'Tap.',
      input: z.object({
        element: z.string(),
      }),
      output: z.object({
        receipt: receipt(),
      }),
      effects: true,
    },
    'ui.drag': {
      description: 'Drag.',
      input: z.object({
        element: ref('ui.element', {
          volatile: true,
        }),
      }),
      output: z.object({
        receipt: receipt(),
      }),
      effects: true,
      required: false,
    },
  },
  events: {
    'ui.changed': {
      payload: z.object({
        channel: ref('chat.channel', {
          public: true,
        }),
      }),
      sense: 'ui',
      replay: 'live',
      required: false,
    },
  },
});

const browser = defineProfile({
  name: 'browser',
  version: '1.2.0',
  extends: {
    ui: ui.range('^1'),
  },
  operations: {
    'browser.open': {
      description: 'Open a URL.',
      input: z.object({
        url: z.string(),
      }),
      output: z.object({
        tab: ref('browser.tab'),
      }),
    },
  },
});

const probe = defineExtension({
  id: 'com.example.probe',
  version: '1.0.0',
  operations: {
    'com.example.probe.look': {
      input: z.object({}),
      output: z.object({}),
    },
  },
});

function manifest(overrides: Partial<ConnectionManifest> = {}): ConnectionManifest {
  return {
    profiles: {
      browser: '1.2.3',
      ui: '1.1.0',
    },
    extensions: {
      'com.example.probe': '1.0.4',
    },
    operations: {
      'ui.tap': {
        name: 'ui.tap',
        inputSchema: {},
      },
      'ui.drag': {
        name: 'ui.drag',
        inputSchema: {},
      },
    },
    resources: {},
    events: {
      'ui.changed': {
        name: 'ui.changed',
        replay: 'live',
      },
    },
    senses: {
      ui: {
        independence: 'actuation-derived',
        grade: 'presence',
      },
    },
    ...overrides,
  };
}

function scope(overrides: Partial<RefScope> = {}): RefScope {
  return {
    connection: 'app',
    threadId: 'thread-1',
    instance: 'inst-1',
    kindInfo: kindInfoFrom(refKindsOf(browser)),
    ...overrides,
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

function refReason(e: unknown): string {
  if (!isNoeticError(e) || e.noeticError.kind !== 'connection_ref_invalid') {
    throw new Error(`expected connection_ref_invalid, got ${String(e)}`);
  }
  return e.noeticError.reason;
}

//#endregion

describe('refKindsOf', () => {
  test('collects ref kinds with their flags from own and inherited parts', () => {
    const kinds = refKindsOf(browser);
    expect(kinds.get('ui.element')).toEqual({
      volatile: true,
      public: false,
    });
    expect(kinds.get('chat.channel')).toEqual({
      volatile: false,
      public: true,
    });
    expect(kinds.get('browser.tab')).toEqual({
      volatile: false,
      public: false,
    });
    expect(kindInfoFrom(kinds)('unknown.kind')).toEqual({
      volatile: false,
      public: false,
    });
  });
});

describe('RefSealer', () => {
  test('seals provider refs and accepts them back on the same thread', async () => {
    const sealer = new RefSealer(makeStorage());
    const sealed = await sealer.sealAll(
      {
        tab: {
          $ref: {
            kind: 'browser.tab',
            id: 't1',
          },
        },
        other: 1,
      },
      scope(),
    );
    const tab = z
      .object({
        tab: RefSchema,
      })
      .parse(sealed).tab;
    expect(tab.$ref.connection).toBe('app');
    expect(tab.$ref.seal.split('.')).toHaveLength(2);
    await sealer.checkAll(sealed, scope());
    expect(refConnections(sealed)).toEqual(
      new Set([
        'app',
      ]),
    );
  });

  test('sealAll leaves values without refs untouched', async () => {
    const value = {
      a: 1,
    };
    expect(await new RefSealer(makeStorage()).sealAll(value, scope())).toBe(value);
  });

  test('a ref used from another thread is connection_ref_invalid', async () => {
    const sealer = new RefSealer(makeStorage());
    const tab = await sealer.seal(
      {
        kind: 'browser.tab',
        id: 't1',
      },
      scope(),
    );
    const e = await rejected(
      sealer.check(
        tab.$ref,
        scope({
          threadId: 'thread-2',
        }),
      ),
    );
    expect(refReason(e)).toContain('not issued by this harness to this thread');
  });

  test('a public ref skips the thread check', async () => {
    const sealer = new RefSealer(makeStorage());
    const channel = await sealer.seal(
      {
        kind: 'chat.channel',
        id: 'C1',
      },
      scope(),
    );
    await sealer.check(
      channel.$ref,
      scope({
        threadId: 'other',
      }),
    );
  });

  test('a ref for another connection is connection_ref_invalid', async () => {
    const sealer = new RefSealer(makeStorage());
    const tab = await sealer.seal(
      {
        kind: 'browser.tab',
        id: 't1',
      },
      scope(),
    );
    const e = await rejected(
      sealer.check(
        tab.$ref,
        scope({
          connection: 'phone',
        }),
      ),
    );
    expect(refReason(e)).toContain("belongs to connection 'app'");
  });

  test('a forged seal is connection_ref_invalid', async () => {
    const sealer = new RefSealer(makeStorage());
    const tab = await sealer.seal(
      {
        kind: 'browser.tab',
        id: 't1',
      },
      scope(),
    );
    const forged = {
      ...tab.$ref,
      id: 't2',
    };
    const e = await rejected(sealer.check(forged, scope()));
    expect(refReason(e)).toContain('not issued');
  });

  test('a volatile ref goes stale when the instance changes; a stable one survives', async () => {
    const sealer = new RefSealer(makeStorage());
    const element = await sealer.seal(
      {
        kind: 'ui.element',
        id: 'e1',
      },
      scope(),
    );
    expect(element.$ref.seal.split('.')).toHaveLength(3);
    await sealer.check(element.$ref, scope());
    const e = await rejected(
      sealer.check(
        element.$ref,
        scope({
          instance: 'inst-2',
        }),
      ),
    );
    expect(refReason(e)).toContain('stale');
    const tab = await sealer.seal(
      {
        kind: 'browser.tab',
        id: 't1',
      },
      scope(),
    );
    await sealer.check(
      tab.$ref,
      scope({
        instance: 'inst-2',
      }),
    );
  });

  test('keys live in storage, so a new sealer verifies old refs; rotation keeps old keys', async () => {
    const storage = makeStorage();
    let now = 0;
    const first = new RefSealer(storage, () => now);
    const tab = await first.seal(
      {
        kind: 'browser.tab',
        id: 't1',
      },
      scope(),
    );
    const second = new RefSealer(storage, () => now);
    await second.check(tab.$ref, scope());
    now = 8 * 24 * 3600e3;
    const rotated = await second.seal(
      {
        kind: 'browser.tab',
        id: 't2',
      },
      scope(),
    );
    expect(rotated.$ref.seal.split('.')[0]).not.toBe(tab.$ref.seal.split('.')[0]);
    await second.check(tab.$ref, scope());
  });
});

describe('negotiation', () => {
  test('checkRequirement passes a satisfied requirement, including parents', () => {
    checkRequirement('app', manifest(), {
      profile: {
        name: 'browser',
        range: '^1.2',
      },
      parents: browser.parents,
      extensions: {
        'com.example.probe': '^1',
      },
      operations: [
        'ui.drag',
      ],
      events: [
        'ui.changed',
      ],
      senses: [
        'ui',
      ],
    });
  });

  const cases: ReadonlyArray<{
    readonly what: string;
    readonly requirement: Parameters<typeof checkRequirement>[2];
    readonly missing: ConnectionMissing;
  }> = [
    {
      what: 'profile version',
      requirement: {
        profile: {
          name: 'browser',
          range: '^2',
        },
      },
      missing: {
        kind: 'profile',
        profile: 'browser',
        range: '^2',
      },
    },
    {
      what: 'parent profile',
      requirement: {
        parents: {
          screen: '^1',
        },
      },
      missing: {
        kind: 'profile',
        profile: 'screen',
        range: '^1',
      },
    },
    {
      what: 'extension',
      requirement: {
        extensions: {
          'com.example.probe': '^2',
        },
      },
      missing: {
        kind: 'extension',
        extension: 'com.example.probe',
        range: '^2',
      },
    },
    {
      what: 'operation',
      requirement: {
        operations: [
          'ui.pinch',
        ],
      },
      missing: {
        kind: 'operation',
        op: 'ui.pinch',
      },
    },
    {
      what: 'event',
      requirement: {
        events: [
          'net.request',
        ],
      },
      missing: {
        kind: 'event',
        event: 'net.request',
      },
    },
    {
      what: 'sense',
      requirement: {
        senses: [
          'net',
        ],
      },
      missing: {
        kind: 'sense',
        sense: 'net',
      },
    },
  ];
  for (const c of cases) {
    test(`a missing ${c.what} is CONNECTION_UNSATISFIED`, () => {
      const e = thrown(() => checkRequirement('app', manifest(), c.requirement));
      expect(isConnectionUnsatisfiedError(e)).toBe(true);
      if (!isConnectionUnsatisfiedError(e)) {
        return;
      }
      expect(e.code).toBe('CONNECTION_UNSATISFIED');
      expect(e.connection).toBe('app');
      expect(e.missing).toEqual(c.missing);
    });
  }

  test('requirementFor derives only optional and foreign parts', () => {
    const handle = connection('app', browser, {
      extensions: [
        probe,
        probe.range('^1.0.2'),
      ],
    });
    expect(
      requirementFor(handle, {
        operations: [
          'ui.tap',
          'ui.drag',
          'com.example.probe.look',
          'ui.drag',
        ],
        events: [
          'ui.changed',
        ],
        senses: [
          'ui',
        ],
      }),
    ).toEqual({
      profile: {
        name: 'browser',
        range: '^1.2.0',
      },
      extensions: {
        'com.example.probe': '^1.0.2',
      },
      operations: [
        'ui.drag',
        'com.example.probe.look',
      ],
      events: [
        'ui.changed',
      ],
      senses: [
        'ui',
      ],
    });
  });

  test('requirementFor without a profile lists every use', () => {
    expect(
      requirementFor(connection('deploys'), {
        events: [
          'deploy.failed',
        ],
      }),
    ).toEqual({
      events: [
        'deploy.failed',
      ],
    });
  });
});

describe('connection()', () => {
  test('defaults the range to the installed profile version; range() overrides', () => {
    const app = connection('app', browser);
    expect(isConnectionHandle(app)).toBe(true);
    expect(app.range).toBe('^1.2.0');
    expect(connection('app', browser.range('^1.1')).range).toBe('^1.1');
    expect(handleTarget(app)).toBe('app');
    expect(
      handleTarget(
        connection('app', browser, {
          from: 'browsers',
          fresh: 'path',
        }),
      ),
    ).toBe('browsers');
    expect(isConnectionHandle({})).toBe(false);
  });

  const invalid: ReadonlyArray<
    readonly [
      string,
      () => unknown,
    ]
  > = [
    [
      'a bad name',
      () => connection('1app'),
    ],
    [
      'a bad from',
      () =>
        connection('app', undefined, {
          from: 'b.c',
        }),
    ],
    [
      'an unknown fresh',
      () =>
        connection('app', undefined, {
          fresh: frameworkFresh('forever'),
        }),
    ],
    [
      'setup without fresh',
      () =>
        connection('app', undefined, {
          setup: {
            url: 'x',
          },
        }),
    ],
  ];
  for (const [what, make] of invalid) {
    test(`${what} is CONNECTION_INVALID`, () => {
      const e = thrown(make);
      expect(isNoeticConfigError(e) && e.code).toBe('CONNECTION_INVALID');
    });
  }
});

function frameworkFresh(value: string): 'run' {
  return JSON.parse(JSON.stringify(value));
}

describe('durability', () => {
  const a = {
    surface: 'web',
    instance: 'i1',
    epoch: 1,
  };
  const replaced = {
    surface: 'web',
    instance: 'i2',
  };
  const base = {
    recorded: a,
    current: replaced,
    rerunAllowed: false,
    canReset: true,
  };

  test('keys combine the run with the ledger key or tool call', () => {
    expect(stepIdempotencyKey('run', 'main/email')).toBe('run:main/email');
    expect(toolIdempotencyKey('run', 'call_1')).toBe('run:tool:call_1');
  });

  test('an epoch change alone keeps results', () => {
    expect(
      sameInstance(a, {
        ...a,
        epoch: 2,
      }),
    ).toBe(true);
    expect(
      resumeDecision({
        ...base,
        current: {
          ...a,
          epoch: 9,
        },
        determinism: undefined,
      }),
    ).toBe('keep');
  });

  test('free discards, costly with reset resets, unsafe refuses', () => {
    const determinism = {
      reset: 'cheap',
      time: 'wall',
      observation: 'exact',
      actions: 'reversible',
    } as const;
    expect(
      resumeDecision({
        ...base,
        determinism: {
          ...determinism,
          replayPrefix: 'free',
        },
      }),
    ).toBe('discard');
    expect(
      resumeDecision({
        ...base,
        determinism: {
          ...determinism,
          replayPrefix: 'costly',
        },
      }),
    ).toBe('reset');
    expect(
      resumeDecision({
        ...base,
        canReset: false,
        determinism: {
          ...determinism,
          replayPrefix: 'costly',
        },
      }),
    ).toBe('refuse');
    expect(
      resumeDecision({
        ...base,
        determinism: {
          ...determinism,
          replayPrefix: 'unsafe',
        },
      }),
    ).toBe('refuse');
    expect(
      resumeDecision({
        ...base,
        determinism: undefined,
      }),
    ).toBe('refuse');
  });

  test('rerun lets a replaced unsafe connection run live', () => {
    expect(
      resumeDecision({
        ...base,
        rerunAllowed: true,
        determinism: undefined,
      }),
    ).toBe('discard');
  });
});
