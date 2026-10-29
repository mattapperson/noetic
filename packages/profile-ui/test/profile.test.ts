import { describe, expect, it } from 'bun:test';
import type { OperationInput, OperationName, OperationOutput } from '@noetic-tools/types';
import { profileFieldOf } from '@noetic-tools/types';
import {
  effectsOutput,
  elementTarget,
  PROFILE_NAME,
  scopeRef,
  UI_ELEMENT_KIND,
  UI_SCOPE_KIND,
  UiNodeSchema,
  UiSummarySchema,
  ui,
} from '../src/index';
import { blobOf, checkOperation, flagsOf, receiptOf, refOf } from './_helpers';

const element = refOf('ui.element');
const tab = refOf('browser.tab');
const noReceipt = {};
const done = {
  receipt: receiptOf(),
};

describe('ui@1 profile', () => {
  it('has its identity', () => {
    expect(PROFILE_NAME).toBe('ui');
    expect(ui.name).toBe('ui');
    expect(ui.version).toBe('1.0.0');
    expect(ui.id).toBe('ui@1');
    expect(ui.defaultRange).toBe('^1.0.0');
    expect(ui.parents).toEqual({});
    expect('determinism' in ui.definition).toBe(false);
  });

  it('declares every catalog operation with its flags', () => {
    const expected: Record<string, Record<string, boolean | string>> = {
      'ui.find': {
        eager: true,
        sense: 'ui',
      },
      'ui.describe': {
        eager: true,
        sense: 'ui',
      },
      'ui.tap': {
        eager: true,
        effects: true,
      },
      'ui.fill': {
        eager: true,
        effects: true,
      },
      'ui.type': {
        effects: true,
      },
      'ui.key': {
        effects: true,
      },
      'ui.scroll': {
        effects: true,
      },
      'ui.select': {
        effects: true,
        optional: true,
      },
      'ui.check': {
        effects: true,
        optional: true,
      },
      'ui.hover': {
        effects: true,
        optional: true,
      },
      'ui.drag': {
        effects: true,
        optional: true,
      },
      'ui.upload': {
        effects: true,
        optional: true,
      },
      'ui.settle': {
        eager: true,
        sense: 'time',
      },
    };
    expect(Object.keys(ui.operations).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, flags] of Object.entries(expected)) {
      expect({
        name,
        flags: flagsOf(ui, name),
      }).toEqual({
        name,
        flags,
      });
    }
  });

  it('declares its reads and events', () => {
    expect(ui.reads['ui.summary']?.look).toBe('turn');
    expect(ui.reads['ui.summary']?.sense).toBe('ui');
    expect(ui.reads['ui.tree']?.look).toBe('effect');
    expect(ui.events['ui.changed']?.required).toBe(false);
    expect(ui.events['ui.changed']?.replay).toBe('live');
    expect(ui.events['ui.changed']?.sense).toBe('ui');
  });

  it('marks element refs volatile and fields as targets and scopes', () => {
    expect(profileFieldOf(elementTarget())).toEqual({
      kind: 'target',
      refKind: UI_ELEMENT_KIND,
    });
    expect(profileFieldOf(scopeRef())).toEqual({
      kind: 'ref',
      refKind: UI_SCOPE_KIND,
      volatile: true,
      public: false,
    });
    expect(scopeRef().safeParse(tab).success).toBe(true);
    expect(scopeRef().safeParse('a tab').success).toBe(false);
    expect(effectsOutput({}).safeParse(done).success).toBe(true);
    expect(effectsOutput({}).safeParse(noReceipt).success).toBe(false);
  });

  it('marks fill and type text sensitive', () => {
    const fill = ui.operations['ui.fill'];
    expect(
      fill?.input.safeParse({
        element: 'textbox "Password"',
        text: {
          $secret: 'APP_PASSWORD',
        },
      }).success,
    ).toBe(true);
  });

  it('ui.find', () => {
    checkOperation(ui, 'ui.find', {
      input: {
        query: 'Pay',
        within: tab,
      },
      badInput: {
        query: '',
      },
      output: {
        elements: [
          {
            element,
            role: 'button',
            name: 'Pay',
          },
        ],
      },
      badOutput: {
        elements: [
          {
            element: 'button "Pay"',
            role: 'button',
            name: 'Pay',
          },
        ],
      },
    });
  });

  it('ui.describe takes element or within, not both', () => {
    const tree = {
      element,
      role: 'main',
      name: '',
      children: [
        {
          element,
          role: 'button',
          name: 'Pay',
        },
      ],
    };
    checkOperation(ui, 'ui.describe', {
      input: {
        element: 'main',
        full: true,
      },
      badInput: {
        element: 'main',
        within: tab,
      },
      output: {
        tree,
      },
      badOutput: {
        tree: {
          element,
          role: '',
          name: 'x',
        },
      },
    });
    expect(ui.operations['ui.describe']?.input.safeParse({}).success).toBe(true);
    expect(
      UiNodeSchema.safeParse({
        ...tree,
        children: [
          {
            role: 'x',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('ui.tap', () => {
    checkOperation(ui, 'ui.tap', {
      input: {
        element: 'button "Pay"',
        count: 2,
      },
      badInput: {
        element: 'button "Pay"',
        count: 0,
      },
      output: done,
      badOutput: noReceipt,
    });
    expect(
      ui.operations['ui.tap']?.input.safeParse({
        element,
      }).success,
    ).toBe(true);
  });

  it('ui.fill and ui.type', () => {
    for (const name of [
      'ui.fill',
      'ui.type',
    ]) {
      checkOperation(ui, name, {
        input: {
          element,
          text: 'hello',
        },
        badInput: {
          element,
          text: 3,
        },
        output: done,
        badOutput: noReceipt,
      });
    }
  });

  it('ui.key', () => {
    checkOperation(ui, 'ui.key', {
      input: {
        key: 'Enter',
        modifiers: [
          'ctrl',
          'shift',
        ],
      },
      badInput: {
        key: 'Enter',
        modifiers: [
          'hyper',
        ],
      },
      output: done,
      badOutput: noReceipt,
    });
  });

  it('ui.scroll takes element or within, not both', () => {
    checkOperation(ui, 'ui.scroll', {
      input: {
        within: tab,
        direction: 'down',
        amount: 3,
      },
      badInput: {
        element,
        within: tab,
        direction: 'down',
      },
      output: done,
      badOutput: noReceipt,
    });
    expect(
      ui.operations['ui.scroll']?.input.safeParse({
        direction: 'sideways',
      }).success,
    ).toBe(false);
    expect(
      ui.operations['ui.scroll']?.input.safeParse({
        direction: 'up',
        amount: 0,
      }).success,
    ).toBe(false);
  });

  it('the optional operations', () => {
    checkOperation(ui, 'ui.select', {
      input: {
        element,
        values: [
          'Red',
        ],
      },
      badInput: {
        element,
        values: [],
      },
      output: done,
      badOutput: noReceipt,
    });
    checkOperation(ui, 'ui.check', {
      input: {
        element,
        checked: true,
      },
      badInput: {
        element,
      },
      output: done,
      badOutput: noReceipt,
    });
    checkOperation(ui, 'ui.hover', {
      input: {
        element,
      },
      badInput: {
        element: '',
      },
      output: done,
      badOutput: noReceipt,
    });
    checkOperation(ui, 'ui.drag', {
      input: {
        element,
        to: 'listitem "Done"',
      },
      badInput: {
        element,
      },
      output: done,
      badOutput: noReceipt,
    });
    checkOperation(ui, 'ui.upload', {
      input: {
        element,
        files: [
          {
            name: 'a.png',
            content: blobOf('image/png'),
          },
        ],
      },
      badInput: {
        element,
        files: [],
      },
      output: done,
      badOutput: noReceipt,
    });
  });

  it('ui.settle requires event exactly when until is event', () => {
    checkOperation(ui, 'ui.settle', {
      input: {
        until: 'quiet',
        quietMs: 500,
        after: receiptOf(),
        timeoutMs: 15e3,
      },
      badInput: {
        until: 'quiet',
        timeoutMs: 0,
      },
      output: {
        closedBy: 'quiescence',
        unmeasurable: true,
      },
      badOutput: {
        closedBy: 'timeout',
      },
    });
    const settle = ui.operations['ui.settle'];
    expect(
      settle?.input.safeParse({
        until: 'event',
        event: 'browser.page.loaded',
        timeoutMs: 1,
      }).success,
    ).toBe(true);
    expect(
      settle?.input.safeParse({
        until: 'event',
        timeoutMs: 1,
      }).success,
    ).toBe(false);
    expect(
      settle?.input.safeParse({
        until: 'quiet',
        event: 'x',
        timeoutMs: 1,
      }).success,
    ).toBe(false);
    expect(
      settle?.input.safeParse({
        until: 'quiet',
      }).success,
    ).toBe(false);
    for (const closedBy of [
      'quiescence',
      'signal',
      'budget-exhausted',
    ]) {
      expect(
        settle?.output.safeParse({
          closedBy,
        }).success,
      ).toBe(true);
    }
  });

  it('ui.summary reads the focused element and counts', () => {
    expect(
      UiSummarySchema.safeParse({
        focused: null,
        counts: {
          button: 3,
        },
      }).success,
    ).toBe(true);
    expect(
      UiSummarySchema.safeParse({
        focused: {
          element,
          role: 'textbox',
          name: 'Email',
        },
        counts: {},
      }).success,
    ).toBe(true);
    expect(
      UiSummarySchema.safeParse({
        focused: null,
        counts: {
          button: -1,
        },
      }).success,
    ).toBe(false);
  });

  it('types operations', () => {
    const name: OperationName<typeof ui> = 'ui.tap';
    const input: OperationInput<typeof ui, 'ui.tap'> = {
      element: 'button "Pay"',
    };
    const output: OperationOutput<typeof ui, 'ui.settle'> = {
      closedBy: 'signal',
    };
    expect([
      name,
      input.element,
      output.closedBy,
    ]).toEqual([
      'ui.tap',
      'button "Pay"',
      'signal',
    ]);
  });
});
