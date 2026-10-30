import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { isNoeticConfigError } from '../src/errors/noetic-config-error';
import type { OperationInput, OperationName, OperationOutput } from '../src/types/profile';
import {
  blob,
  defineExtension,
  defineProfile,
  parseProfileRequirement,
  profileFieldOf,
  receipt,
  ref,
  SenseDefaults,
  SenseIdSchema,
  ServerProfileDeclarationSchema,
  sensitive,
  target,
} from '../src/types/profile';

const SHA = 'b'.repeat(64);

function expectInvalid(fn: () => unknown, fragment: string): void {
  try {
    fn();
    throw new Error('expected a CONNECTION_INVALID error');
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('CONNECTION_INVALID');
    expect(e.message).toContain(fragment);
  }
}

const ui = defineProfile({
  name: 'ui',
  version: '1.1.0',
  operations: {
    'ui.tap': {
      description: 'Tap an element.',
      input: z.object({
        element: target('ui.element'),
      }),
      output: z.object({
        receipt: receipt(),
      }),
      eager: true,
      effects: true,
    },
  },
  reads: {
    'ui.summary': {
      schema: z.object({
        focused: z.string().optional(),
      }),
      sense: 'ui',
      look: 'turn',
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
    'browser.navigate': {
      description: 'Go to a URL.',
      input: z.object({
        url: z.string(),
      }),
      output: z.object({
        url: z.string(),
        title: z.string(),
        receipt: receipt(),
      }),
      effects: true,
    },
  },
  events: {
    'browser.page.loaded': {
      payload: z.object({
        url: z.string(),
      }),
      sense: 'route',
      replay: 'live',
    },
  },
});

describe('defineProfile', () => {
  it('derives id, major and the default range', () => {
    expect(browser.id).toBe('browser@1');
    expect(browser.major).toBe(1);
    expect(browser.defaultRange).toBe('^1.2.0');
  });

  it('inherits parent parts unchanged and records parent ranges', () => {
    expect(Object.keys(browser.operations).sort()).toEqual([
      'browser.navigate',
      'ui.tap',
    ]);
    expect(browser.operations['ui.tap']).toBe(ui.operations['ui.tap']);
    expect(browser.reads['ui.summary']).toBeDefined();
    expect(browser.parents).toEqual({
      ui: '^1',
    });
  });

  it('declares a parent by range without inheriting', () => {
    const p = defineProfile({
      name: 'app',
      version: '1.0.0',
      extends: {
        ui: '^1',
      },
    });
    expect(p.parents).toEqual({
      ui: '^1',
    });
    expect(Object.keys(p.operations)).toEqual([]);
  });

  it('types operations from own and inherited parts', () => {
    const op: OperationName<typeof browser> = 'ui.tap';
    const input: OperationInput<typeof browser, 'browser.navigate'> = {
      url: 'https://example.com',
    };
    const output: OperationOutput<typeof browser, 'ui.tap'> = {
      receipt: {
        actionId: 'a1',
        cursor: null,
      },
    };
    expect(op).toBe('ui.tap');
    expect(input.url).toContain('example');
    expect(output.receipt.actionId).toBe('a1');
  });

  it('range() returns a pinned requirement', () => {
    const r = browser.range('^1.1');
    expect(r.kind).toBe('profile-range');
    expect(r.profile).toBe(browser);
    expect(r.range).toBe('^1.1');
  });

  it('rejects a malformed name', () => {
    expectInvalid(
      () =>
        defineProfile({
          name: 'Browser',
          version: '1.0.0',
        }),
      'one lowercase label',
    );
  });

  it('rejects a non-semver version', () => {
    expectInvalid(
      () =>
        defineProfile({
          name: 'x',
          version: '1.0',
        }),
      'not semver',
    );
  });

  it('rejects a bad range', () => {
    expectInvalid(() => browser.range('not a range'), 'not a semver range');
    expectInvalid(
      () =>
        defineProfile({
          name: 'x',
          version: '1.0.0',
          extends: {
            ui: 'nope!',
          },
        }),
      'not a semver range',
    );
  });

  it('rejects names MCP tools cannot carry', () => {
    expectInvalid(
      () =>
        defineProfile({
          name: 'x',
          version: '1.0.0',
          reads: {
            'x read': {
              schema: z.string(),
              sense: 'ui',
            },
          },
        }),
      "part 'x read'",
    );
  });

  it('rejects an effects operation without a receipt', () => {
    expectInvalid(
      () =>
        defineProfile({
          name: 'x',
          version: '1.0.0',
          operations: {
            'x.do': {
              description: 'd',
              input: z.object({}),
              output: z.object({}),
              effects: true,
            },
          },
        }),
      'no receipt()',
    );
  });

  it("rejects 'once' without 'effects'", () => {
    expectInvalid(
      () =>
        defineProfile({
          name: 'x',
          version: '1.0.0',
          operations: {
            'x.do': {
              description: 'd',
              input: z.object({}),
              output: z.object({}),
              once: true,
            },
          },
        }),
      "'once' without 'effects'",
    );
  });

  it('rejects an undeclared x- sense and accepts a declared one', () => {
    const part = {
      'x.read': {
        schema: z.string(),
        sense: 'x-orders-db' as const,
      },
    };
    expectInvalid(
      () =>
        defineProfile({
          name: 'x',
          version: '1.0.0',
          reads: part,
        }),
      'without declaring',
    );
    const ok = defineProfile({
      name: 'x',
      version: '1.0.0',
      reads: part,
      senses: {
        'x-orders-db': {
          independence: 'independent',
          grade: 'consequence',
        },
      },
    });
    expect(ok.reads['x.read']).toBeDefined();
  });

  it('rejects redefining an inherited part', () => {
    expectInvalid(
      () =>
        defineProfile({
          name: 'browser',
          version: '1.0.0',
          extends: {
            ui: ui.range('^1'),
          },
          reads: {
            'ui.summary': {
              schema: z.string(),
              sense: 'ui',
            },
          },
        }),
      "redefines inherited part 'ui.summary'",
    );
  });

  it('rejects a parent keyed under another name', () => {
    expectInvalid(
      () =>
        defineProfile({
          name: 'x',
          version: '1.0.0',
          extends: {
            screen: ui.range('^1'),
          },
        }),
      "lists 'ui' under 'screen'",
    );
  });
});

describe('field helpers', () => {
  it('ref() validates kind and records volatile/public', () => {
    const element = ref('ui.element', {
      volatile: true,
    });
    expect(profileFieldOf(element)).toEqual({
      kind: 'ref',
      refKind: 'ui.element',
      volatile: true,
      public: false,
    });
    expect(
      element.safeParse({
        $ref: {
          connection: 'a',
          kind: 'ui.element',
          id: 'e1',
          seal: 's',
        },
      }).success,
    ).toBe(true);
    expect(
      element.safeParse({
        $ref: {
          connection: 'a',
          kind: 'ui.window',
          id: 'e1',
          seal: 's',
        },
      }).success,
    ).toBe(false);
  });

  it('profileFieldOf looks through optional, nullable and default', () => {
    expect(profileFieldOf(ref('chat.thread').optional())?.kind).toBe('ref');
    expect(profileFieldOf(ref('chat.thread').nullable())?.kind).toBe('ref');
    expect(profileFieldOf(z.string())).toBeUndefined();
  });

  it('target() accepts a ref or a locator', () => {
    const t = target('ui.element');
    expect(t.safeParse('button "Pay"').success).toBe(true);
    expect(t.safeParse('').success).toBe(false);
    expect(profileFieldOf(t)).toEqual({
      kind: 'target',
      refKind: 'ui.element',
    });
  });

  it('sensitive() accepts the value or a secret', () => {
    const s = sensitive(z.string());
    expect(s.safeParse('hunter2').success).toBe(true);
    expect(
      s.safeParse({
        $secret: 'app.password',
      }).success,
    ).toBe(true);
    expect(s.safeParse(42).success).toBe(false);
    expect(profileFieldOf(s)?.kind).toBe('sensitive');
  });

  it('blob() filters by mime type, wildcards included', () => {
    const image = blob([
      'image/*',
    ]);
    const png = {
      $blob: {
        uri: `artifact://sha256/${SHA}`,
        mimeType: 'image/png',
        bytes: 3,
        sha256: SHA,
      },
    };
    expect(image.safeParse(png).success).toBe(true);
    expect(
      image.safeParse({
        $blob: {
          ...png.$blob,
          mimeType: 'video/mp4',
        },
      }).success,
    ).toBe(false);
    expect(profileFieldOf(image)).toEqual({
      kind: 'blob',
      mimeTypes: [
        'image/*',
      ],
    });
  });

  it('blob(…, { sensitive: true }) marks content never rendered to the model', () => {
    const session = blob([], {
      sensitive: true,
    });
    expect(profileFieldOf(session)).toEqual({
      kind: 'blob',
      mimeTypes: [],
      sensitive: true,
    });
  });

  it('receipt() is a fresh, marked schema each call', () => {
    const a = receipt();
    expect(a).not.toBe(receipt());
    expect(profileFieldOf(a)?.kind).toBe('receipt');
    expect(
      a.safeParse({
        actionId: 'x',
        cursor: null,
      }).success,
    ).toBe(true);
  });
});

describe('defineExtension', () => {
  const blocks = defineExtension({
    id: 'com.slack.blocks',
    version: '3.0.0',
    requires: {
      chat: '^1',
    },
    operations: {
      'com.slack.blocks.post': {
        input: z.object({
          blocks: z.array(z.unknown()),
        }),
        output: z.object({
          receipt: receipt(),
        }),
        effects: true,
        once: true,
      },
    },
    extend: {
      'chat.post': {
        input: z.object({
          unfurlLinks: z.boolean().optional(),
        }),
      },
    },
  });

  it('defines an extension with a range', () => {
    expect(blocks.major).toBe(3);
    expect(blocks.range('^3').range).toBe('^3');
    expect(blocks.defaultRange).toBe('^3.0.0');
  });

  it('rejects an id with fewer than three labels', () => {
    expectInvalid(
      () =>
        defineExtension({
          id: 'slack.blocks',
          version: '1.0.0',
        }),
      'reverse domain',
    );
  });

  it('rejects parts not named under its id', () => {
    expectInvalid(
      () =>
        defineExtension({
          id: 'com.acme.probe',
          version: '1.0.0',
          reads: {
            'probe.state': {
              schema: z.string(),
              sense: 'state',
            },
          },
        }),
      "not named under 'com.acme.probe'",
    );
  });

  it('rejects read and event names MCP cannot carry', () => {
    expectInvalid(
      () =>
        defineExtension({
          id: 'com.acme.probe',
          version: '1.0.0',
          reads: {
            'com.acme.probe.state now': {
              schema: z.string(),
              sense: 'state',
            },
          },
        }),
      'characters MCP tool names cannot carry',
    );
    expectInvalid(
      () =>
        defineExtension({
          id: 'com.acme.probe',
          version: '1.0.0',
          events: {
            'com.acme.probe/changed': {
              payload: z.object({}),
              sense: 'state',
              replay: 'live',
            },
          },
        }),
      'characters MCP tool names cannot carry',
    );
  });

  it('rejects an extend that adds a required field', () => {
    expectInvalid(
      () =>
        defineExtension({
          id: 'com.acme.probe',
          version: '1.0.0',
          extend: {
            'chat.post': {
              input: z.object({
                must: z.string(),
              }),
            },
          },
        }),
      "field 'must' required",
    );
  });

  it('rejects a bad requirement range', () => {
    expectInvalid(
      () =>
        defineExtension({
          id: 'com.acme.probe',
          version: '1.0.0',
          requires: {
            chat: 'one',
          },
        }),
      'not a semver range',
    );
  });
});

describe('senses and declarations', () => {
  it('SenseDefaults mirrors OVP CHANNEL_DEFAULTS', () => {
    expect(SenseDefaults.net).toEqual({
      independence: 'independent',
      grade: 'consequence',
    });
    expect(SenseDefaults.ui.independence).toBe('actuation-derived');
  });

  it('SenseIdSchema accepts named and x- senses only', () => {
    expect(SenseIdSchema.safeParse('net').success).toBe(true);
    expect(SenseIdSchema.safeParse('x-orders-db').success).toBe(true);
    expect(SenseIdSchema.safeParse('sound').success).toBe(false);
  });

  it('parses profile requirements', () => {
    expect(parseProfileRequirement('browser@^1.2')).toEqual({
      profile: 'browser',
      range: '^1.2',
    });
    expect(parseProfileRequirement('browser')).toBeUndefined();
    expect(parseProfileRequirement('@^1')).toBeUndefined();
    expect(parseProfileRequirement('browser@')).toBeUndefined();
    expect(parseProfileRequirement('Browser@^1')).toBeUndefined();
  });

  it('validates a server declaration', () => {
    const declaration = {
      profiles: {
        browser: '1.2.0',
        ui: '1.1.0',
      },
      extensions: {
        'com.example.probe': '1.0.0',
      },
      senses: {
        ui: {
          independence: 'actuation-derived',
          grade: 'presence',
        },
      },
      determinism: {
        reset: 'cheap',
        replayPrefix: 'free',
        time: 'wall',
        observation: 'exact',
        actions: 'reversible',
      },
      aliases: {
        'ui.find': {
          tool: 'probe_look',
          fixed: {
            action: 'find',
          },
        },
      },
      instances: [
        {
          id: 'ctx-1',
          title: 'Chromium',
        },
      ],
    };
    expect(ServerProfileDeclarationSchema.safeParse(declaration).success).toBe(true);
    expect(
      ServerProfileDeclarationSchema.safeParse({
        profiles: {
          browser: '1.2',
        },
      }).success,
    ).toBe(false);
  });
});
