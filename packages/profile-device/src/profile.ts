/**
 * The `device@1` profile (spec 36 § Catalog v1), extending `ui@^1`:
 * simulators, emulators and phones. Platform-specific features — permission
 * dialogs, intents — are extensions.
 */

import { effectsOutput, ui } from '@noetic-tools/profile-ui';
import { blob, defineProfile, ref, SenseDefaults } from '@noetic-tools/types';
import { z } from 'zod';

//#region Field schemas

/** @public The ref kind of an installed app. */
export const DEVICE_APP_KIND = 'device.app';

function deviceAppRef(): ReturnType<typeof ref<'device.app'>> {
  return ref(DEVICE_APP_KIND);
}

//#endregion

//#region Schemas

/** @public A device orientation. */
export const DeviceOrientationSchema = z.enum([
  'portrait',
  'portrait-upside-down',
  'landscape-left',
  'landscape-right',
]);

/** @public What `device.info` returns. */
export const DeviceInfoSchema = z.object({
  platform: z.string().min(1),
  osVersion: z.string().min(1),
  model: z.string().min(1),
  orientation: DeviceOrientationSchema,
  /** The hardware buttons `device.button` accepts. */
  buttons: z.array(z.string().min(1)),
});

/** @public One log line `device.logs` returns. */
export const DeviceLogLineSchema = z.object({
  /** In the `log` summary format: `error message`. */
  summary: z.string(),
  level: z.string().min(1),
  text: z.string(),
  time: z.string().optional(),
});

/** @public What `device.summary` reads. */
export const DeviceSummarySchema = z.object({
  platform: z.string(),
  model: z.string(),
  orientation: DeviceOrientationSchema,
  foreground: z
    .object({
      app: deviceAppRef(),
      bundleId: z.string(),
    })
    .nullable(),
});

const launchInput = z
  .object({
    app: deviceAppRef().optional(),
    bundleId: z.string().min(1).optional(),
  })
  .refine((v) => (v.app === undefined) !== (v.bundleId === undefined), {
    message: 'Give app or bundleId, exactly one.',
  });

//#endregion

//#region Profile

/** @public The `device@1` profile. */
export const device = defineProfile({
  name: 'device',
  version: '1.0.0',
  description: 'A simulator, emulator or phone: apps, buttons, URLs, logs.',
  extends: {
    ui: ui.range('^1'),
  },
  surface: 'mobile',
  determinism: {
    reset: 'costly',
    replayPrefix: 'costly',
    time: 'wall',
    observation: 'exact',
    actions: 'reversible',
  },
  operations: {
    'device.info': {
      description: 'The platform, OS version, model, orientation and buttons.',
      input: z.object({}),
      output: DeviceInfoSchema,
      eager: true,
    },
    'device.app.install': {
      description: 'Install an app.',
      input: z.object({
        path: z.string().min(1),
      }),
      output: effectsOutput({
        app: deviceAppRef(),
      }),
      effects: true,
      once: true,
    },
    'device.app.launch': {
      description: 'Launch an installed app.',
      input: launchInput,
      output: effectsOutput({
        app: deviceAppRef(),
      }),
      effects: true,
      eager: true,
    },
    'device.app.terminate': {
      description: 'Terminate an app.',
      input: z.object({
        app: deviceAppRef(),
      }),
      output: effectsOutput({}),
      effects: true,
    },
    'device.openUrl': {
      description: 'Open a URL or deep link.',
      input: z.object({
        url: z.string().min(1),
      }),
      output: effectsOutput({}),
      effects: true,
    },
    'device.button': {
      description: 'Press a hardware button, one of device.info buttons; else unsupported.',
      input: z.object({
        name: z.string().min(1),
      }),
      output: effectsOutput({}),
      effects: true,
    },
    'device.rotate': {
      description: 'Rotate the device.',
      input: z.object({
        orientation: DeviceOrientationSchema,
      }),
      output: effectsOutput({}),
      effects: true,
      required: false,
    },
    'device.appearance': {
      description: 'Switch light or dark appearance.',
      input: z.object({
        appearance: z.enum([
          'light',
          'dark',
        ]),
      }),
      output: effectsOutput({}),
      effects: true,
      required: false,
    },
    'device.logs': {
      description: 'Log lines, optionally for one app or since a cursor.',
      input: z.object({
        app: deviceAppRef().optional(),
        since: z.string().optional(),
      }),
      output: z.object({
        lines: z.array(DeviceLogLineSchema),
      }),
      sense: 'log',
      required: false,
    },
    'device.test.run': {
      description: 'Run a test plan on the device.',
      input: z.object({
        plan: z.string().min(1),
      }),
      output: effectsOutput({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        report: blob([]),
      }),
      effects: true,
      once: true,
      required: false,
    },
  },
  reads: {
    'device.summary': {
      description: 'The platform, model, orientation and foreground app.',
      schema: DeviceSummarySchema,
      sense: 'ui',
      look: 'turn',
    },
  },
  events: {
    'device.app.crashed': {
      description: 'An app crashed.',
      payload: z.object({
        app: deviceAppRef().optional(),
        bundleId: z.string().min(1),
        reason: z.string().optional(),
        report: blob([]).optional(),
        /** In the `log` summary format: `error message`. */
        summary: z.string(),
      }),
      sense: 'log',
      replay: 'durable',
    },
  },
  setup: {
    schema: z.object({
      model: z.string().min(1).optional(),
      osVersion: z.string().min(1).optional(),
    }),
  },
  senses: {
    ui: SenseDefaults.ui,
    log: SenseDefaults.log,
  },
});

//#endregion
