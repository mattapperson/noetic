/**
 * A small profile pair for tests — `ui@1` and `kiosk@1` (extends `ui`) — and
 * a server fixture that implements both, declaring itself under
 * `tools.noetic/profiles`.
 */

import { defineExtension, defineProfile, receipt, sensitive, target } from '@noetic-tools/types';
import { z } from 'zod';
import type { TestServerOptions, TestTool } from './_helpers';
import { identityResource, refusal, structured } from './_helpers';

//#region Profiles

export const ui = defineProfile({
  name: 'ui',
  version: '1.0.0',
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
      sense: 'ui',
    },
    'ui.find': {
      description: 'Find elements.',
      input: z.object({
        query: z.string(),
      }),
      output: z.object({
        elements: z.array(z.unknown()),
      }),
      eager: true,
      sense: 'ui',
    },
    'ui.drag': {
      description: 'Drag.',
      input: z.object({
        element: target('ui.element'),
      }),
      output: z.object({
        receipt: receipt(),
      }),
      effects: true,
      required: false,
    },
  },
  reads: {
    'ui.summary': {
      schema: z.object({
        focused: z.string(),
      }),
      sense: 'ui',
      look: 'turn',
    },
  },
  determinism: {
    reset: 'cheap',
    replayPrefix: 'free',
    time: 'wall',
    observation: 'exact',
    actions: 'reversible',
  },
});

export const kiosk = defineProfile({
  name: 'kiosk',
  version: '1.0.0',
  extends: {
    ui: ui.range('^1'),
  },
  operations: {
    'kiosk.print': {
      description: 'Print a ticket.',
      input: z.object({
        text: sensitive(z.string()),
      }),
      output: z.object({
        receipt: receipt(),
      }),
      effects: true,
      once: true,
      guarded: true,
    },
  },
  events: {
    'kiosk.printed': {
      payload: z.object({
        text: z.string(),
      }),
      sense: 'x-paper',
      replay: 'live',
      thread: 'ticket',
    },
  },
  senses: {
    'x-paper': {
      independence: 'independent',
      grade: 'consequence',
    },
  },
});

export const stamps = defineExtension({
  id: 'com.example.stamps',
  version: '1.0.0',
  requires: {
    kiosk: '^1',
  },
  operations: {
    'com.example.stamps.stamp': {
      input: z.object({
        ink: z.string(),
      }),
      output: z.object({
        receipt: receipt(),
      }),
      effects: true,
    },
  },
});

//#endregion

//#region Server fixture

export interface KioskState {
  instance: string;
  epoch: number;
  printed: Map<
    string,
    {
      args: string;
      result: Record<string, unknown>;
    }
  >;
  actions: number;
}

export function kioskState(): KioskState {
  return {
    instance: 'kiosk-1',
    epoch: 0,
    printed: new Map(),
    actions: 0,
  };
}

export function kioskTools(state: KioskState): TestTool[] {
  return [
    {
      name: 'ui.tap',
      inputSchema: {
        type: 'object',
        properties: {
          element: {},
        },
        required: [
          'element',
        ],
      },
      handler: (args) => {
        if (args.element === 'button') {
          return refusal('ambiguous', 'two buttons match', {
            candidates: [
              'button "A"',
              'button "B"',
            ],
          });
        }
        if (args.element === 'gone') {
          return refusal('stale_reference', 'that element is gone');
        }
        if (args.element === undefined) {
          return refusal('malformed', 'element is required');
        }
        state.actions++;
        return structured({
          receipt: {
            actionId: `a${state.actions}`,
            cursor: `c${state.actions}`,
          },
        });
      },
    },
    {
      name: 'probe_look',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
          },
          query: {
            type: 'string',
          },
        },
        required: [
          'action',
          'query',
        ],
      },
      handler: (args) =>
        structured({
          elements: [
            {
              action: args.action,
              query: args.query,
            },
          ],
        }),
    },
    {
      name: 'kiosk.print',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
          },
        },
        required: [
          'text',
        ],
      },
      handler: (args, meta) => {
        const key = String(meta['tools.noetic/idempotency-key']);
        const prior = state.printed.get(key);
        const serialized = JSON.stringify(args);
        if (prior !== undefined) {
          return prior.args === serialized
            ? structured(prior.result)
            : refusal('conflict', 'key reused with new arguments');
        }
        if (meta['tools.noetic/confirmed'] !== true) {
          return refusal('guarded', 'printing needs approval');
        }
        state.actions++;
        const result = {
          receipt: {
            actionId: `a${state.actions}`,
            cursor: null,
          },
        };
        state.printed.set(key, {
          args: serialized,
          result,
        });
        return structured(result);
      },
    },
    {
      name: 'noetic.reset',
      handler: () => {
        state.instance = `kiosk-${state.epoch + 2}`;
        state.epoch++;
        return structured({});
      },
    },
    {
      name: 'noetic.detect',
      inputSchema: {
        type: 'object',
        properties: {
          since: {},
        },
      },
      handler: () =>
        structured({
          anomalies: [
            {
              kind: 'receipt-without-effect',
              tier: 'observed',
              claim: 'printed',
              counter: 'no paper',
              between: [
                'x-paper',
                'ui',
              ],
              evidence: [
                'e1',
              ],
            },
          ],
        }),
    },
  ];
}

export function kioskDeclaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profiles: {
      kiosk: '1.0.0',
      ui: '1.1.0',
    },
    senses: {
      ui: {
        independence: 'actuation-derived',
        grade: 'presence',
      },
      'x-paper': {
        independence: 'independent',
        grade: 'consequence',
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
    ...overrides,
  };
}

export function kioskServerOptions(
  state: KioskState,
  overrides: Partial<TestServerOptions> = {},
): TestServerOptions {
  return {
    declaration: kioskDeclaration(),
    tools: kioskTools(state),
    resources: [
      identityResource(() => ({
        surface: 'x-kiosk',
        instance: state.instance,
        epoch: state.epoch,
      })),
      {
        uri: 'noetic://read/ui.summary',
        name: 'ui.summary',
        mimeType: 'application/json',
        read: () => ({
          text: JSON.stringify({
            focused: 'button "Print"',
          }),
        }),
      },
      {
        uri: 'noetic://coverage',
        name: 'coverage',
        mimeType: 'application/json',
        read: () => ({
          text: JSON.stringify([
            {
              kind: 'channel-unobserved',
              sense: 'x-paper',
              detail: 'printer offline',
              impeaching: true,
            },
          ]),
        }),
      },
    ],
    events: [
      {
        name: 'kiosk.printed',
        replay: 'live',
      },
      {
        name: 'identity.changed',
      },
    ],
    delivery: [
      'push',
      'poll',
    ],
    ...overrides,
  };
}

//#endregion
