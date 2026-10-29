/**
 * The `app@1` profile (spec 36 § Catalog v1), extending `ui@^1`: desktop
 * applications. A server offers `app.launch`, `app.attach` or both — see
 * `offersLaunchOrAttach`.
 */

import { effectsOutput, ui } from '@noetic-tools/profile-ui';
import { defineProfile, ref, SenseDefaults } from '@noetic-tools/types';
import { z } from 'zod';
import { EXIT_SENSE_DESCRIPTOR, TERMINATION_SENSE_DESCRIPTOR } from './senses';

//#region Field schemas

/** @public The ref kind of an application. */
export const APP_KIND = 'app.app';

/** @public The ref kind of a window. Window refs are volatile. */
export const APP_WINDOW_KIND = 'app.window';

function appRef(): ReturnType<typeof ref<'app.app'>> {
  return ref(APP_KIND);
}

function windowRef(): ReturnType<typeof ref<'app.window'>> {
  return ref(APP_WINDOW_KIND, {
    volatile: true,
  });
}

//#endregion

//#region Schemas

/** @public What `app.summary` reads. */
export const AppSummarySchema = z.object({
  app: appRef().nullable(),
  name: z.string(),
  windows: z.number().int().nonnegative(),
  focused: z
    .object({
      window: windowRef(),
      title: z.string(),
    })
    .nullable(),
});

/** @public The host-only fields of the app setup: only the pool's own setup may set them. */
export const APP_HOST_ONLY_SETUP: ReadonlyArray<string> = [
  'path',
  'command',
  'env',
];

/** @public What a pool accepts to create a fresh app: a `path` or a `command`, not both. */
export const AppSetupSchema = z
  .object({
    path: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .refine((v) => (v.path === undefined) !== (v.command === undefined), {
    message: 'Give path or command, exactly one.',
  });

//#endregion

//#region Profile

/** @public The `app@1` profile. */
export const app = defineProfile({
  name: 'app',
  version: '1.0.0',
  description: 'A desktop application: launch or attach, windows, state.',
  extends: {
    ui: ui.range('^1'),
  },
  surface: 'desktop',
  determinism: {
    reset: 'costly',
    replayPrefix: 'costly',
    time: 'wall',
    observation: 'exact',
    actions: 'reversible',
  },
  operations: {
    'app.launch': {
      description: 'Launch the app this connection was set up for.',
      input: z.object({}),
      output: effectsOutput({
        app: appRef(),
      }),
      effects: true,
      eager: true,
      required: false,
    },
    'app.attach': {
      description: 'Attach to an app already running.',
      input: z.object({
        match: z.string().min(1).optional(),
      }),
      output: z.object({
        app: appRef(),
      }),
      required: false,
    },
    'app.windows': {
      description: "List the app's windows.",
      input: z.object({
        app: appRef().optional(),
      }),
      output: z.object({
        windows: z.array(
          z.object({
            window: windowRef(),
            title: z.string(),
            focused: z.boolean(),
          }),
        ),
      }),
      eager: true,
    },
    'app.window.focus': {
      description: 'Bring a window to the front.',
      input: z.object({
        window: windowRef(),
      }),
      output: effectsOutput({}),
      effects: true,
    },
    'app.terminate': {
      description: 'Quit an app.',
      input: z.object({
        app: appRef(),
      }),
      output: effectsOutput({}),
      effects: true,
    },
    'app.state': {
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
  },
  reads: {
    'app.summary': {
      description: 'The app, its window count and the focused window.',
      schema: AppSummarySchema,
      sense: 'ui',
      look: 'turn',
    },
  },
  events: {
    'app.exited': {
      description: 'The app exited on its own, with its exit code.',
      payload: z.object({
        app: appRef(),
        code: z.number().int(),
        /** In the `x-exit` summary format: `exit CODE`. */
        summary: z.string(),
      }),
      sense: 'x-exit',
      replay: 'live',
    },
    'app.terminated': {
      description: 'The operating system or a supervisor ended the app.',
      payload: z.object({
        app: appRef(),
        reason: z.string().min(1),
        /** In the `x-termination` summary format: `terminated REASON`. */
        summary: z.string(),
      }),
      sense: 'x-termination',
      replay: 'live',
    },
    'app.signal': {
      description: 'A signal the application announced.',
      payload: z.object({
        name: z.string().min(1),
        data: z.unknown().optional(),
        /** In the `signal` summary format: the name. */
        summary: z.string(),
      }),
      sense: 'signal',
      replay: 'live',
      required: false,
    },
  },
  setup: {
    schema: AppSetupSchema,
    hostOnly: APP_HOST_ONLY_SETUP,
  },
  senses: {
    ui: SenseDefaults.ui,
    state: SenseDefaults.state,
    signal: SenseDefaults.signal,
    'x-exit': EXIT_SENSE_DESCRIPTOR,
    'x-termination': TERMINATION_SENSE_DESCRIPTOR,
  },
});

/** @public Whether a server's operation names include `app.launch`, `app.attach` or both, as `app@1` requires. */
export function offersLaunchOrAttach(operations: ReadonlyArray<string>): boolean {
  return operations.includes('app.launch') || operations.includes('app.attach');
}

//#endregion
