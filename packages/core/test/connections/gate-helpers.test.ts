import { describe, expect, test } from 'bun:test';
import { isNoeticConfigError, isNoeticError, REDACTED_TEXT, secret } from '@noetic-tools/types';
import { matchesAnyGlob, matchesGlob } from '../../src/connections/glob';
import {
  describeJsonPath,
  secretAllowedAt,
  validateJsonSchema,
} from '../../src/connections/json-schema';
import { evaluatePolicy } from '../../src/connections/policy';
import {
  checkSecrets,
  fillSecrets,
  findSecrets,
  SecretScrubber,
} from '../../src/connections/secrets';
import { findDeep, mapDeep, setAtPath } from '../../src/connections/values';

const FILL_SCHEMA = {
  type: 'object',
  properties: {
    element: {
      type: 'string',
    },
    text: {
      anyOf: [
        {
          type: 'string',
        },
        {
          type: 'object',
          properties: {
            $secret: {
              type: 'string',
            },
          },
          required: [
            '$secret',
          ],
        },
      ],
    },
  },
  required: [
    'element',
    'text',
  ],
  additionalProperties: false,
} as const;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('glob', () => {
  test('* spans dots, ? is one character, everything else is literal', () => {
    expect(matchesGlob('ui.*', 'ui.tap')).toBe(true);
    expect(matchesGlob('ui.*', 'ui.tree.read')).toBe(true);
    expect(matchesGlob('ui.*', 'uix.tap')).toBe(false);
    expect(matchesGlob('com.slack.admin.*', 'com.slack.admin.users')).toBe(true);
    expect(matchesGlob('ui.ta?', 'ui.tap')).toBe(true);
    expect(matchesGlob('ui.(x)', 'ui.(x)')).toBe(true);
    expect(matchesGlob('ui.tap', 'ui_tap')).toBe(false);
  });

  test('matchesAnyGlob is false for an absent or empty list', () => {
    expect(matchesAnyGlob(undefined, 'a')).toBe(false);
    expect(matchesAnyGlob([], 'a')).toBe(false);
    expect(
      matchesAnyGlob(
        [
          'b',
          'a*',
        ],
        'abc',
      ),
    ).toBe(true);
  });
});

describe('evaluatePolicy', () => {
  test('no policy allows without approval; guarded needs approval', () => {
    expect(evaluatePolicy(undefined, 'ui.tap', false)).toEqual({
      kind: 'allow',
      needsApproval: false,
      explicitlyAllowed: false,
    });
    expect(evaluatePolicy(undefined, 'chat.delete', true)).toEqual({
      kind: 'allow',
      needsApproval: true,
      explicitlyAllowed: false,
    });
  });

  test('deny wins over allow', () => {
    const verdict = evaluatePolicy(
      {
        allow: [
          '*',
        ],
        deny: [
          'com.slack.admin.*',
        ],
      },
      'com.slack.admin.kick',
      false,
    );
    expect(verdict.kind).toBe('deny');
  });

  test('an allow list refuses what it does not name, and lets guarded ops it names run unapproved', () => {
    const policy = {
      allow: [
        'chat.*',
      ],
    };
    expect(evaluatePolicy(policy, 'ui.tap', false).kind).toBe('deny');
    expect(evaluatePolicy(policy, 'chat.delete', true)).toEqual({
      kind: 'allow',
      needsApproval: false,
      explicitlyAllowed: true,
    });
  });

  test('approve globs need approval', () => {
    expect(
      evaluatePolicy(
        {
          approve: [
            'chat.post',
          ],
        },
        'chat.post',
        false,
      ),
    ).toEqual({
      kind: 'allow',
      needsApproval: true,
      explicitlyAllowed: false,
    });
  });
});

describe('validateJsonSchema', () => {
  test('accepts matching arguments and reports every problem otherwise', () => {
    expect(
      validateJsonSchema(FILL_SCHEMA, {
        element: 'textbox "Email"',
        text: 'a@b.c',
      }),
    ).toEqual([]);
    const errors = validateJsonSchema(FILL_SCHEMA, {
      element: 3,
      extra: true,
    });
    expect(errors).toContain('.element: expected string, got integer');
    expect(errors).toContain('.text: required');
    expect(errors).toContain('.extra: unexpected property');
  });

  test('enum, const, arrays, strings, numbers and $ref', () => {
    const schema = {
      $defs: {
        Size: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
        },
      },
      type: 'object',
      properties: {
        mode: {
          enum: [
            'a',
            'b',
          ],
        },
        fixed: {
          const: 1,
        },
        tags: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 2,
            pattern: '^t',
          },
          minItems: 1,
          maxItems: 2,
        },
        size: {
          $ref: '#/$defs/Size',
        },
        ratio: {
          type: 'number',
          exclusiveMinimum: 0,
          exclusiveMaximum: 1,
        },
        all: {
          allOf: [
            {
              type: 'string',
            },
            {
              maxLength: 1,
            },
          ],
        },
      },
    };
    expect(
      validateJsonSchema(schema, {
        mode: 'a',
        fixed: 1,
        tags: [
          'tx',
        ],
        size: 2,
        ratio: 0.5,
        all: 'x',
      }),
    ).toEqual([]);
    const errors = validateJsonSchema(schema, {
      mode: 'c',
      fixed: 2,
      tags: [
        'x',
        'ty',
        'tz',
      ],
      size: 4,
      ratio: 1,
      all: 'xy',
    });
    expect(errors.length).toBeGreaterThanOrEqual(7);
  });

  test('nothing is defaulted: a missing required field is an error even with a default', () => {
    const schema = {
      type: 'object',
      properties: {
        n: {
          type: 'number',
          default: 1,
        },
      },
      required: [
        'n',
      ],
    };
    expect(validateJsonSchema(schema, {})).toEqual([
      '.n: required',
    ]);
  });

  test('describeJsonPath renders keys and indexes', () => {
    expect(describeJsonPath([])).toBe('(root)');
    expect(
      describeJsonPath([
        'a',
        0,
        'b',
      ]),
    ).toBe('.a[0].b');
  });
});

describe('secretAllowedAt', () => {
  test('only where the schema accepts { $secret }', () => {
    expect(
      secretAllowedAt(FILL_SCHEMA, [
        'text',
      ]),
    ).toBe(true);
    expect(
      secretAllowedAt(FILL_SCHEMA, [
        'element',
      ]),
    ).toBe(false);
    expect(
      secretAllowedAt(FILL_SCHEMA, [
        'missing',
      ]),
    ).toBe(false);
  });

  test('looks through arrays and additionalProperties', () => {
    const schema = {
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: FILL_SCHEMA.properties.text,
        },
      },
      additionalProperties: FILL_SCHEMA.properties.text,
    };
    expect(
      secretAllowedAt(schema, [
        'list',
        0,
      ]),
    ).toBe(true);
    expect(
      secretAllowedAt(schema, [
        'other',
      ]),
    ).toBe(true);
  });
});

describe('values', () => {
  test('mapDeep copies and replaces; findDeep reports paths; setAtPath replaces one node', () => {
    const value = {
      a: [
        1,
        {
          b: 2,
        },
      ],
    };
    const doubled = mapDeep(value, (node) =>
      typeof node.value === 'number'
        ? {
            replace: node.value * 2,
          }
        : undefined,
    );
    expect(doubled).toEqual({
      a: [
        2,
        {
          b: 4,
        },
      ],
    });
    expect(value.a[0]).toBe(1);
    const numbers = findDeep(value, (v): v is number => typeof v === 'number');
    expect(numbers.map((n) => n.path)).toEqual([
      [
        'a',
        0,
      ],
      [
        'a',
        1,
        'b',
      ],
    ]);
    expect(
      setAtPath(
        value,
        [
          'a',
          1,
          'b',
        ],
        'x',
      ),
    ).toEqual({
      a: [
        1,
        {
          b: 'x',
        },
      ],
    });
  });
});

describe('secrets', () => {
  test('the scrubber replaces raw, URL-encoded and base64 forms', () => {
    const scrubber = new SecretScrubber();
    expect(scrubber.active).toBe(false);
    expect(scrubber.scrubText('p@ss w0rd')).toBe('p@ss w0rd');
    scrubber.add('p@ss w0rd');
    scrubber.add('');
    expect(scrubber.active).toBe(true);
    const encoded = encodeURIComponent('p@ss w0rd');
    const b64 = btoa('p@ss w0rd');
    expect(scrubber.scrubText(`x p@ss w0rd ${encoded} ${b64} y`)).toBe(
      `x ${REDACTED_TEXT} ${REDACTED_TEXT} ${REDACTED_TEXT} y`,
    );
    expect(
      scrubber.scrub({
        nested: [
          `token=${encoded}`,
        ],
        n: 1,
      }),
    ).toEqual({
      nested: [
        `token=${REDACTED_TEXT}`,
      ],
      n: 1,
    });
  });

  test('findSecrets finds each secret with its path', () => {
    expect(
      findSecrets({
        a: secret('x'),
        b: [
          secret('y'),
        ],
      }).map((s) => s.path),
    ).toEqual([
      [
        'a',
      ],
      [
        'b',
        0,
      ],
    ]);
  });

  test('checkSecrets refuses secrets from the model (connection_secret_refused)', () => {
    const e = thrown(() =>
      checkSecrets(
        {
          element: 'x',
          text: secret('app.password'),
        },
        {
          connection: 'app',
          op: 'ui.fill',
          caller: 'model',
          inputSchema: FILL_SCHEMA,
        },
      ),
    );
    expect(isNoeticError(e)).toBe(true);
    if (!isNoeticError(e)) {
      return;
    }
    expect(e.noeticError).toEqual({
      kind: 'connection_secret_refused',
      connection: 'app',
      op: 'ui.fill',
    });
  });

  test('checkSecrets refuses a secret outside a sensitive field and allows one inside', () => {
    const site = {
      connection: 'app',
      op: 'ui.fill',
      caller: 'step',
      inputSchema: FILL_SCHEMA,
    } as const;
    const e = thrown(() =>
      checkSecrets(
        {
          element: secret('x'),
          text: 'a',
        },
        site,
      ),
    );
    expect(isNoeticError(e) && e.noeticError.kind).toBe('connection_secret_refused');
    expect(() =>
      checkSecrets(
        {
          element: 'e',
          text: secret('x'),
        },
        site,
      ),
    ).not.toThrow();
  });

  test('fillSecrets resolves each name once and registers values for scrubbing', async () => {
    const scrubber = new SecretScrubber();
    const asked: string[] = [];
    const filled = await fillSecrets(
      {
        a: secret('pw'),
        b: secret('pw'),
        c: 'plain',
      },
      {
        resolver: {
          async resolve(name) {
            asked.push(name);
            return 'hunter2';
          },
        },
        scrubber,
        signal: new AbortController().signal,
      },
    );
    expect(filled).toEqual({
      a: 'hunter2',
      b: 'hunter2',
      c: 'plain',
    });
    expect(asked).toEqual([
      'pw',
    ]);
    expect(scrubber.scrubText('hunter2')).toBe(REDACTED_TEXT);
  });

  test('fillSecrets passes arguments without secrets through untouched', async () => {
    const args = {
      a: 1,
    };
    const filled = await fillSecrets(args, {
      resolver: undefined,
      scrubber: new SecretScrubber(),
      signal: new AbortController().signal,
    });
    expect(filled).toBe(args);
  });

  test('fillSecrets without a resolver is CONNECTION_INVALID', async () => {
    const e = await rejected(
      fillSecrets(
        {
          a: secret('pw'),
        },
        {
          resolver: undefined,
          scrubber: new SecretScrubber(),
          signal: new AbortController().signal,
        },
      ),
    );
    expect(isNoeticConfigError(e) && e.code).toBe('CONNECTION_INVALID');
  });
});
