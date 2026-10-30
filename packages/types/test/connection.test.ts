import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import {
  ConnectionUnsatisfiedError,
  isConnectionUnsatisfiedError,
} from '../src/errors/connection-errors';
import { isNoeticConfigError } from '../src/errors/noetic-config-error';
import { NoeticErrorImpl } from '../src/errors/noetic-error';
import type { Connection, ConnectionMissing, ConnectionProvider } from '../src/types/connection';
import {
  BlobRefSchema,
  ConnectionErrorPayloadSchema,
  isBlobRef,
  isConnectionProvider,
  isRef,
  isSecret,
  normalizeConnectionEntry,
  RefSchema,
  refId,
  refSchemaOf,
  secret,
} from '../src/types/connection';
import type { NoeticError } from '../src/types/error';

const SHA = 'a'.repeat(64);

const REF = {
  $ref: {
    connection: 'slack',
    kind: 'chat.thread',
    id: 'T1',
    seal: 'sig',
  },
};

const BLOB = {
  $blob: {
    uri: `artifact://sha256/${SHA}`,
    mimeType: 'image/png',
    bytes: 12,
    sha256: SHA,
  },
};

function fakeProvider(): ConnectionProvider {
  return {
    connect: async (): Promise<ReadonlyArray<Connection>> => [],
  };
}

describe('secret()', () => {
  it('returns the $secret wrapper JSON uses', () => {
    expect(secret('app.password')).toEqual({
      $secret: 'app.password',
    });
    expect(isSecret(secret('x'))).toBe(true);
  });

  it('throws CONNECTION_INVALID for an empty name', () => {
    try {
      secret('');
      throw new Error('expected secret() to throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('CONNECTION_INVALID');
    }
  });
});

describe('ref and blob values', () => {
  it('recognises well-formed refs and reads their id', () => {
    expect(isRef(REF)).toBe(true);
    assert(isRef(REF));
    expect(refId(REF)).toBe('T1');
    expect(RefSchema.safeParse(REF).success).toBe(true);
  });

  it('rejects refs missing a seal or carrying extra keys', () => {
    expect(
      isRef({
        $ref: {
          connection: 'a',
          kind: 'k',
          id: '1',
        },
      }),
    ).toBe(false);
    expect(
      isRef({
        ...REF,
        extra: true,
      }),
    ).toBe(false);
    expect(isRef('T1')).toBe(false);
    expect(isRef(null)).toBe(false);
  });

  it('refSchemaOf checks the kind', () => {
    expect(refSchemaOf('chat.thread').safeParse(REF).success).toBe(true);
    expect(refSchemaOf('chat.message').safeParse(REF).success).toBe(false);
  });

  it('recognises blobs and requires a sha256 digest', () => {
    expect(isBlobRef(BLOB)).toBe(true);
    expect(
      BlobRefSchema.safeParse({
        $blob: {
          ...BLOB.$blob,
          sha256: 'nope',
        },
      }).success,
    ).toBe(false);
    expect(isBlobRef(REF)).toBe(false);
  });
});

describe('connection entries', () => {
  it('expands a bare provider to { provider }', () => {
    const provider = fakeProvider();
    expect(normalizeConnectionEntry(provider)).toEqual({
      provider,
    });
  });

  it('keeps a full entry as is', () => {
    const entry = {
      provider: fakeProvider(),
      pool: {
        max: 2,
      },
      expose: 'all' as const,
    };
    expect(normalizeConnectionEntry(entry)).toBe(entry);
  });

  it('isConnectionProvider checks for a connect function', () => {
    expect(isConnectionProvider(fakeProvider())).toBe(true);
    expect(
      isConnectionProvider({
        connect: 1,
      }),
    ).toBe(false);
    expect(isConnectionProvider(undefined)).toBe(false);
  });
});

describe('ConnectionErrorPayloadSchema', () => {
  it('accepts every spec 36 code', () => {
    for (const code of [
      'undeclared',
      'ambiguous',
      'stale_reference',
      'conflict',
    ]) {
      expect(
        ConnectionErrorPayloadSchema.safeParse({
          code,
          message: 'm',
        }).success,
      ).toBe(true);
    }
  });

  it('rejects an unknown code', () => {
    expect(
      ConnectionErrorPayloadSchema.safeParse({
        code: 'oops',
        message: 'm',
      }).success,
    ).toBe(false);
  });
});

describe('ConnectionUnsatisfiedError', () => {
  const cases: Array<
    [
      ConnectionMissing,
      string,
    ]
  > = [
    [
      {
        kind: 'profile',
        profile: 'browser',
        range: '^1.2',
      },
      'profile browser@^1.2',
    ],
    [
      {
        kind: 'extension',
        extension: 'com.acme.x',
        range: '^1',
      },
      'extension com.acme.x@^1',
    ],
    [
      {
        kind: 'operation',
        op: 'ui.tap',
      },
      "operation 'ui.tap'",
    ],
    [
      {
        kind: 'event',
        event: 'chat.message.created',
      },
      "event 'chat.message.created'",
    ],
    [
      {
        kind: 'sense',
        sense: 'net',
      },
      "sense 'net'",
    ],
  ];

  for (const [missing, text] of cases) {
    it(`names the missing ${missing.kind}`, () => {
      const error = new ConnectionUnsatisfiedError({
        connection: 'app',
        missing,
      });
      expect(error.code).toBe('CONNECTION_UNSATISFIED');
      expect(error.message).toContain(text);
      expect(error.missing).toEqual(missing);
      expect(isConnectionUnsatisfiedError(error)).toBe(true);
      expect(isNoeticConfigError(error)).toBe(true);
    });
  }
});

describe('connection NoeticError kinds', () => {
  const cases: Array<
    [
      NoeticError,
      string,
    ]
  > = [
    [
      {
        kind: 'connection_unavailable',
        connection: 'app',
        reason: 'disconnected',
      },
      "Connection 'app' is unavailable: disconnected",
    ],
    [
      {
        kind: 'connection_failed',
        connection: 'app',
        op: 'ui.tap',
        error: {
          code: 'ambiguous',
          message: 'two buttons',
        },
      },
      "Connection 'app' failed 'ui.tap' (ambiguous): two buttons",
    ],
    [
      {
        kind: 'connection_ref_invalid',
        connection: 'app',
        reason: 'stale',
      },
      "Connection 'app' refused a ref: stale",
    ],
    [
      {
        kind: 'connection_secret_refused',
        connection: 'app',
        op: 'ui.tap',
      },
      "refused a secret in 'ui.tap'",
    ],
    [
      {
        kind: 'connection_input_required',
        connection: 'phone',
        request: {
          id: 'r1',
          message: 'Trust this computer?',
        },
      },
      'Trust this computer?',
    ],
    [
      {
        kind: 'connection_resume_refused',
        connection: 'team',
        reason: 'replaced',
      },
      "Connection 'team' cannot be resumed: replaced",
    ],
    [
      {
        kind: 'verify_act_failed',
        stepId: 'checkout',
        cause: new Error('boom'),
      },
      "Verify 'checkout' act failed: boom",
    ],
  ];

  for (const [error, text] of cases) {
    it(`formats ${error.kind}`, () => {
      const thrown = new NoeticErrorImpl(error);
      expect(thrown.noeticError.kind).toBe(error.kind);
      expect(thrown.message).toContain(text);
    });
  }
});
