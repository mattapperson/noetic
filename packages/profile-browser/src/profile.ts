/**
 * The `browser@1` profile (spec 36 § Catalog v1), extending `ui@^1`.
 *
 * A browser server reaches OVP's `effect` level with `net` and `log`,
 * `in-realm` adding `state` and `signal`, and `surface` adding `ui`.
 */

import { effectsOutput, parseNetMatcher, UiNodeSchema, ui } from '@noetic-tools/profile-ui';
import { blob, defineProfile, ref, SenseDefaults } from '@noetic-tools/types';
import { z } from 'zod';
import { ARTIFACT_SENSE_DESCRIPTOR } from './senses';

//#region Field schemas

/** @public The ref kind of a tab. Tab refs are volatile. */
export const BROWSER_TAB_KIND = 'browser.tab';

/** @public The ref kind of a dialog. Dialog refs are volatile. */
export const BROWSER_DIALOG_KIND = 'browser.dialog';

function tabRef(): ReturnType<typeof ref<'browser.tab'>> {
  return ref(BROWSER_TAB_KIND, {
    volatile: true,
  });
}

function dialogRef(): ReturnType<typeof ref<'browser.dialog'>> {
  return ref(BROWSER_DIALOG_KIND, {
    volatile: true,
  });
}

const optionalTab = z.object({
  tab: tabRef().optional(),
});

const cursorFilter = {
  since: z.string().optional(),
  actionId: z.string().min(1).optional(),
};

const actionArguments = z.object({
  actionId: z.string().min(1).optional(),
});

const netFilter = z.string().refine((text) => parseNetMatcher(text).ok, {
  message: 'filter must be a net matcher, e.g. POST /api/* 5xx.',
});

//#endregion

//#region Schemas

/** @public One request `browser.requests` returns and `browser.request` carries. */
export const BrowserRequestSchema = z.object({
  /** In the `net` summary format: `POST /api/orders 201`. */
  summary: z.string(),
  method: z.string().min(1),
  url: z.string().min(1),
  status: z.number().int().nullable(),
  timing: z.object({
    startMs: z.number().nonnegative(),
    durationMs: z.number().nonnegative().optional(),
  }),
});

/** @public One console message `browser.console` returns and `browser.console.message` carries. */
export const BrowserConsoleMessageSchema = z.object({
  /** In the `log` summary format: `error Uncaught TypeError: …`. */
  summary: z.string(),
  level: z.string().min(1),
  text: z.string(),
  time: z.string().optional(),
});

/** @public What `browser.page.summary` reads. */
export const BrowserPageSummarySchema = z.object({
  url: z.string(),
  title: z.string(),
  /** In the `route` summary format: the path. */
  route: z.string(),
});

/** @public What a pool accepts to create a fresh browser. */
export const BrowserSetupSchema = z.object({
  url: z.string().min(1).optional(),
  // A stored session carries credentials: never rendered to the model.
  session: blob([], {
    sensitive: true,
  }).optional(),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  locale: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
});

//#endregion

//#region Profile

/** @public The `browser@1` profile. */
export const browser = defineProfile({
  name: 'browser',
  version: '1.0.0',
  description: 'A web browser: pages, tabs, dialogs, requests and console.',
  extends: {
    ui: ui.range('^1'),
  },
  surface: 'web',
  determinism: {
    reset: 'cheap',
    replayPrefix: 'free',
    time: 'wall',
    observation: 'exact',
    actions: 'reversible',
  },
  operations: {
    'browser.navigate': {
      description: 'Go to a URL.',
      input: z.object({
        url: z.string().min(1),
        tab: tabRef().optional(),
      }),
      output: effectsOutput({
        url: z.string(),
        title: z.string(),
      }),
      effects: true,
      eager: true,
    },
    'browser.back': {
      description: 'Go back in history.',
      input: optionalTab,
      output: effectsOutput({
        url: z.string(),
      }),
      effects: true,
    },
    'browser.forward': {
      description: 'Go forward in history.',
      input: optionalTab,
      output: effectsOutput({
        url: z.string(),
      }),
      effects: true,
    },
    'browser.reload': {
      description: 'Reload the page.',
      input: optionalTab,
      output: effectsOutput({
        url: z.string(),
      }),
      effects: true,
    },
    'browser.tabs': {
      description: 'List open tabs.',
      input: z.object({}),
      output: z.object({
        tabs: z.array(
          z.object({
            tab: tabRef(),
            url: z.string(),
            title: z.string(),
            active: z.boolean(),
          }),
        ),
      }),
    },
    'browser.tab.open': {
      description: 'Open a tab, optionally at a URL.',
      input: z.object({
        url: z.string().min(1).optional(),
      }),
      output: effectsOutput({
        tab: tabRef(),
      }),
      effects: true,
    },
    'browser.tab.close': {
      description: 'Close a tab.',
      input: z.object({
        tab: tabRef(),
      }),
      output: effectsOutput({
        tab: tabRef(),
      }),
      effects: true,
    },
    'browser.tab.select': {
      description: 'Make a tab the active one.',
      input: z.object({
        tab: tabRef(),
      }),
      output: effectsOutput({
        tab: tabRef(),
      }),
      effects: true,
    },
    'browser.dialog.respond': {
      description: 'Accept or dismiss a dialog, with text for a prompt.',
      input: z.object({
        dialog: dialogRef(),
        accept: z.boolean(),
        text: z.string().optional(),
      }),
      output: effectsOutput({}),
      effects: true,
    },
    'browser.requests': {
      description: 'Requests since a cursor or caused by an action.',
      input: z.object({
        ...cursorFilter,
        filter: netFilter.optional(),
      }),
      output: z.object({
        requests: z.array(BrowserRequestSchema),
      }),
      sense: 'net',
      required: false,
    },
    'browser.console': {
      description: 'Console messages since a cursor or caused by an action.',
      input: z.object({
        ...cursorFilter,
        level: z.string().min(1).optional(),
      }),
      output: z.object({
        messages: z.array(BrowserConsoleMessageSchema),
      }),
      sense: 'log',
      required: false,
    },
    'browser.state': {
      description: 'Application state, from an SDK inside the app.',
      input: z.object({
        path: z.string().min(1).optional(),
      }),
      output: z.object({
        value: z.unknown(),
      }),
      sense: 'state',
      required: false,
    },
    'browser.evaluate': {
      description: 'Evaluate a JavaScript expression in the page.',
      input: z.object({
        expression: z.string().min(1),
        tab: tabRef().optional(),
      }),
      output: z.object({
        value: z.unknown(),
      }),
      guarded: true,
      required: false,
    },
  },
  reads: {
    'browser.page.summary': {
      description: 'The URL, title and route of the active page.',
      schema: BrowserPageSummarySchema,
      sense: 'route',
      look: 'turn',
    },
    'browser.page': {
      description: 'The active page in full.',
      schema: BrowserPageSummarySchema.extend({
        tree: UiNodeSchema,
      }),
      sense: 'ui',
      look: 'effect',
    },
  },
  events: {
    'browser.page.loaded': {
      description: 'A page finished loading.',
      payload: z.object({
        tab: tabRef().optional(),
        url: z.string(),
        title: z.string().optional(),
        /** In the `route` summary format. */
        summary: z.string(),
      }),
      arguments: actionArguments,
      sense: 'route',
      replay: 'live',
    },
    'browser.dialog.opened': {
      description: 'A dialog opened.',
      payload: z.object({
        dialog: dialogRef(),
        type: z.enum([
          'alert',
          'confirm',
          'prompt',
          'beforeunload',
        ]),
        message: z.string(),
        defaultValue: z.string().optional(),
        /** In the `ui` summary format: `dialog "message"`. */
        summary: z.string(),
      }),
      arguments: actionArguments,
      sense: 'ui',
      replay: 'live',
    },
    'browser.request': {
      description: 'A request completed or failed.',
      payload: BrowserRequestSchema,
      arguments: actionArguments,
      sense: 'net',
      replay: 'live',
      required: false,
    },
    'browser.console.message': {
      description: 'A console message.',
      payload: BrowserConsoleMessageSchema,
      arguments: actionArguments,
      sense: 'log',
      replay: 'live',
      required: false,
    },
    'browser.signal': {
      description: 'A signal the application announced.',
      payload: z.object({
        name: z.string().min(1),
        data: z.unknown().optional(),
        /** In the `signal` summary format: the name. */
        summary: z.string(),
      }),
      arguments: actionArguments,
      sense: 'signal',
      replay: 'live',
      required: false,
    },
    'browser.download': {
      description: 'A file was downloaded.',
      payload: z.object({
        filename: z.string().min(1),
        file: blob([]),
        /** In the `x-artifact` summary format: `download "filename"`. */
        summary: z.string(),
      }),
      arguments: actionArguments,
      sense: 'x-artifact',
      replay: 'live',
      required: false,
    },
  },
  setup: {
    schema: BrowserSetupSchema,
  },
  senses: {
    ui: SenseDefaults.ui,
    net: SenseDefaults.net,
    log: SenseDefaults.log,
    route: SenseDefaults.route,
    state: SenseDefaults.state,
    signal: SenseDefaults.signal,
    'x-artifact': ARTIFACT_SENSE_DESCRIPTOR,
  },
});

//#endregion
