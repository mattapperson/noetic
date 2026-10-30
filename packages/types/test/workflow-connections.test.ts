import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { WorkflowDocument, WorkflowNode } from '../src/schemas/workflow';
import {
  isWorkflowOpShorthand,
  shorthandStepId,
  stepEntryToNode,
  stepListEntries,
  verifyMatcherFromJson,
  WorkflowConnectionRequirementSchema,
  WorkflowDocumentSchema,
  WorkflowNodeSchema,
  WorkflowValueSchema,
  WorkflowVerifyMatcherSchema,
  walkWorkflow,
} from '../src/schemas/workflow';

const SPEC_DOCUMENT = {
  version: 1,
  connections: {
    app: {
      profile: 'browser@^1.2',
      from: 'browsers',
      fresh: 'path',
      setup: {
        url: 'http://localhost:5173/login',
      },
    },
    phone: {
      profile: 'device@^1',
      extensions: {
        'com.acme.ios-permissions': '^1.0',
      },
    },
    deploys: {
      events: [
        'deploy.failed',
      ],
    },
  },
  root: {
    kind: 'sequence',
    id: 'main',
    steps: [
      {
        kind: 'call',
        id: 'email',
        connection: 'app',
        op: 'ui.fill',
        args: {
          element: 'textbox "Email"',
          text: 'qa@example.com',
        },
      },
      {
        kind: 'call',
        id: 'password',
        connection: 'app',
        op: 'ui.fill',
        args: {
          element: 'textbox "Password"',
          text: {
            $secret: 'app.password',
          },
        },
      },
      {
        kind: 'call',
        id: 'sign-in',
        connection: 'app',
        op: 'ui.tap',
        args: {
          element: 'button "Sign in"',
        },
      },
    ],
  },
};

const VERIFY_NODE = {
  kind: 'verify',
  id: 'checkout',
  subject: 'app',
  expect: [
    {
      net: 'POST /api/orders 201',
      count: 1,
    },
    {
      ui: 'heading "Order confirmed"',
    },
  ],
  never: [
    {
      net: '5xx',
    },
  ],
  act: [
    {
      'ui.tap': {
        element: 'button "Pay"',
      },
    },
  ],
};

function parseNode(node: unknown): WorkflowNode {
  return WorkflowNodeSchema.parse(node);
}

describe('connections manifest', () => {
  it("validates spec 35's example document", () => {
    const doc: WorkflowDocument = WorkflowDocumentSchema.parse(SPEC_DOCUMENT);
    expect(Object.keys(doc.connections ?? {})).toEqual([
      'app',
      'phone',
      'deploys',
    ]);
  });

  it('rejects an entry that names nothing', () => {
    expect(
      WorkflowConnectionRequirementSchema.safeParse({
        from: 'browsers',
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed profile requirement', () => {
    expect(
      WorkflowConnectionRequirementSchema.safeParse({
        profile: 'browser',
      }).success,
    ).toBe(false);
    expect(
      WorkflowConnectionRequirementSchema.safeParse({
        profile: 'browser@^1',
      }).success,
    ).toBe(true);
  });

  it('rejects extension ids that are not reverse domains, and bad ranges', () => {
    expect(
      WorkflowConnectionRequirementSchema.safeParse({
        extensions: {
          probe: '^1',
        },
      }).success,
    ).toBe(false);
    expect(
      WorkflowConnectionRequirementSchema.safeParse({
        extensions: {
          'com.acme.probe': 'soon',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields and bad connection names', () => {
    expect(
      WorkflowConnectionRequirementSchema.safeParse({
        profile: 'browser@^1',
        pool: {},
      }).success,
    ).toBe(false);
    expect(
      WorkflowDocumentSchema.safeParse({
        ...SPEC_DOCUMENT,
        connections: {
          '1app': {
            profile: 'browser@^1',
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe('call and wait nodes', () => {
  it('parses a call with an expression connection and expression args', () => {
    const node = parseNode({
      kind: 'call',
      id: 'c',
      connection: {
        $expr: '$item',
      },
      op: 'ui.tap',
      args: {
        $expr: '{ "element": $steps.find.elements[0].element }',
      },
    });
    assert(node.kind === 'call');
    expect(node.connection).toEqual({
      $expr: '$item',
    });
  });

  it('rejects an op without a dot', () => {
    expect(
      WorkflowNodeSchema.safeParse({
        kind: 'call',
        id: 'c',
        op: 'tap',
      }).success,
    ).toBe(false);
  });

  it('parses a wait with around, filter and timeout', () => {
    const node = parseNode({
      kind: 'wait',
      id: 'approval',
      connection: 'team',
      event: 'chat.message.created',
      filter: 'event.payload.thread.id = input.thread.id',
      around: {
        kind: 'call',
        id: 'ask',
        connection: 'team',
        op: 'chat.reply',
        args: {
          text: 'Approve?',
        },
      },
      timeoutMs: 18e5,
    });
    assert(node.kind === 'wait');
    expect(
      [
        ...walkWorkflow(node),
      ].map((n) => n.id),
    ).toEqual([
      'approval',
      'ask',
    ]);
  });

  it('accepts a cron tick event and requires a positive timeout', () => {
    expect(
      WorkflowNodeSchema.safeParse({
        kind: 'wait',
        id: 'w',
        event: 'tick',
        timeoutMs: 1,
      }).success,
    ).toBe(true);
    expect(
      WorkflowNodeSchema.safeParse({
        kind: 'wait',
        id: 'w',
        event: 'tick',
        timeoutMs: 0,
      }).success,
    ).toBe(false);
  });
});

describe('values', () => {
  it('accepts JSON, wrappers, refs and blobs', () => {
    for (const value of [
      null,
      1,
      'x',
      [
        1,
        {
          a: true,
        },
      ],
      {
        $expr: '$steps.a',
      },
      {
        $literal: {
          $weird: 1,
        },
      },
      {
        $secret: 'app.password',
      },
      {
        $ref: {
          connection: 'slack',
          kind: 'chat.thread',
          id: 'T',
          seal: 's',
        },
      },
      {
        $blob: {
          uri: `artifact://sha256/${'c'.repeat(64)}`,
          mimeType: 'image/png',
          bytes: 1,
          sha256: 'c'.repeat(64),
        },
      },
      {},
    ]) {
      expect(WorkflowValueSchema.safeParse(value).success).toBe(true);
    }
  });

  it('rejects unknown $-keys and empty wrappers', () => {
    expect(
      WorkflowValueSchema.safeParse({
        $foo: 1,
      }).success,
    ).toBe(false);
    expect(
      WorkflowValueSchema.safeParse({
        nested: {
          $secret: '',
        },
      }).success,
    ).toBe(false);
    expect(
      WorkflowValueSchema.safeParse({
        $expr: '',
      }).success,
    ).toBe(false);
  });
});

describe('operation shorthand', () => {
  it('accepts an operation by name in a sequence and walks only nodes', () => {
    const node = parseNode({
      kind: 'sequence',
      id: 's',
      steps: [
        {
          'ui.tap': {
            element: 'button "Pay"',
          },
        },
        {
          kind: 'compute',
          id: 'c',
          expr: '1',
        },
      ],
    });
    assert(node.kind === 'sequence');
    const first = node.steps[0];
    assert(first !== undefined);
    expect(isWorkflowOpShorthand(first)).toBe(true);
    expect(
      [
        ...walkWorkflow(node),
      ].map((n) => n.id),
    ).toEqual([
      's',
      'c',
    ]);
  });

  it('converts a shorthand to a call node without a connection', () => {
    const node = stepEntryToNode(
      {
        'ui.tap': {
          element: 'x',
        },
      },
      shorthandStepId('s', 0),
    );
    expect(node).toEqual({
      kind: 'call',
      id: 's[0]',
      op: 'ui.tap',
      args: {
        element: 'x',
      },
    });
  });

  it('returns a node entry unchanged', () => {
    const compute: WorkflowNode = {
      kind: 'compute',
      id: 'c',
      expr: '1',
    };
    expect(stepEntryToNode(compute, 'ignored')).toBe(compute);
    expect(stepListEntries(compute)).toEqual([
      compute,
    ]);
  });

  it('rejects a shorthand with two operations', () => {
    expect(
      WorkflowNodeSchema.safeParse({
        kind: 'sequence',
        id: 's',
        steps: [
          {
            'ui.tap': {},
            'ui.fill': {},
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('verify node', () => {
  it("parses spec 37's JSON example", () => {
    const node = parseNode(VERIFY_NODE);
    assert(node.kind === 'verify');
    expect(node.expect).toHaveLength(2);
  });

  it('parses OVP claims and constraints given directly, with defaults', () => {
    const node = parseNode({
      kind: 'verify',
      id: 'v',
      subject: [
        'ios',
        'android',
      ],
      claims: [
        {
          id: 'c1',
          statement: 'The order was placed.',
          declaredAt: 'before-action',
        },
      ],
      constraints: [
        {
          id: 'k1',
          statement: 'No server errors.',
          channels: [
            'net',
          ],
        },
      ],
      act: {
        'ui.tap': {
          element: 'button "Pay"',
        },
      },
    });
    assert(node.kind === 'verify');
    expect(node.claims?.[0]?.assertions).toEqual([]);
    expect(node.constraints?.[0]?.severity).toBe('blocking');
  });

  it('requires exactly one of expect or claims', () => {
    const { expect: _matchers, ...noExpect } = VERIFY_NODE;
    expect(WorkflowNodeSchema.safeParse(noExpect).success).toBe(false);
    expect(
      WorkflowNodeSchema.safeParse({
        ...VERIFY_NODE,
        claims: [
          {
            id: 'c',
            statement: 's',
            declaredAt: 'before-action',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects never together with constraints', () => {
    expect(
      WorkflowNodeSchema.safeParse({
        ...VERIFY_NODE,
        constraints: [
          {
            id: 'k',
            statement: 's',
            channels: [
              'net',
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('checks close.event against until', () => {
    expect(
      WorkflowNodeSchema.safeParse({
        ...VERIFY_NODE,
        close: {
          until: 'event',
        },
      }).success,
    ).toBe(false);
    expect(
      WorkflowNodeSchema.safeParse({
        ...VERIFY_NODE,
        close: {
          until: 'event',
          event: 'browser.signal',
          timeoutMs: 5e3,
        },
      }).success,
    ).toBe(true);
  });

  it('walks act nodes', () => {
    const node = parseNode({
      ...VERIFY_NODE,
      act: [
        {
          kind: 'call',
          id: 'pay',
          op: 'ui.tap',
        },
      ],
    });
    expect(
      [
        ...walkWorkflow(node),
      ].map((n) => n.id),
    ).toEqual([
      'checkout',
      'pay',
    ]);
  });
});

describe('verify matchers', () => {
  it('accepts one sense or event with bounds', () => {
    for (const matcher of [
      {
        net: 'POST /api/orders 201',
        count: 1,
      },
      {
        state: 'cart.total',
        equals: 42,
        tolerance: 0.5,
      },
      {
        event: 'device.app.crashed',
      },
      {
        'x-orders-db': 'orders.count',
        count: 1,
      },
      {
        log: 'error',
        atLeast: 1,
        atMost: 3,
      },
    ]) {
      expect(WorkflowVerifyMatcherSchema.safeParse(matcher).success).toBe(true);
    }
  });

  it('rejects unknown keys, two senses, none, and count with bounds', () => {
    for (const matcher of [
      {
        sound: 'beep',
      },
      {
        net: 'a',
        ui: 'b',
      },
      {
        count: 1,
      },
      {
        net: 'a',
        count: 1,
        atLeast: 1,
      },
    ]) {
      expect(WorkflowVerifyMatcherSchema.safeParse(matcher).success).toBe(false);
    }
  });

  it('converts JSON matchers to their TypeScript form', () => {
    expect(
      verifyMatcherFromJson({
        net: 'POST /api/orders 201',
        count: 1,
      }),
    ).toEqual({
      kind: 'sense',
      sense: 'net',
      match: 'POST /api/orders 201',
      count: 1,
    });
    expect(
      verifyMatcherFromJson({
        event: 'device.app.crashed',
        atLeast: 1,
      }),
    ).toEqual({
      kind: 'event',
      event: 'device.app.crashed',
      atLeast: 1,
    });
    expect(
      verifyMatcherFromJson({
        state: 'cart.total',
        equals: 42,
        tolerance: 0.5,
      }),
    ).toEqual({
      kind: 'sense',
      sense: 'state',
      match: 'cart.total',
      equals: 42,
      tolerance: 0.5,
    });
    expect(
      verifyMatcherFromJson({
        count: 1,
      }),
    ).toBeUndefined();
  });
});

describe('inParallel over connections', () => {
  it('accepts a list of connection names with each', () => {
    const node = parseNode({
      kind: 'inParallel',
      id: 'fan',
      mode: 'all',
      over: [
        'ios',
        'android',
      ],
      each: {
        kind: 'call',
        id: 'tap',
        connection: {
          $expr: '$item',
        },
        op: 'ui.tap',
      },
    });
    assert(node.kind === 'inParallel');
    expect(node.over).toEqual([
      'ios',
      'android',
    ]);
  });
});
