import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { ui } from '@noetic-tools/profile-ui';
import {
  DEVICE_APP_KIND,
  DeviceInfoSchema,
  DeviceSummarySchema,
  device,
  PROFILE_NAME,
} from '../src/index';
import { blobOf, checkOperation, flagsOf, receiptOf, refOf } from './_helpers';

const appRef = refOf('device.app');
const done = {
  receipt: receiptOf(),
};
const info = {
  platform: 'ios',
  osVersion: '18.0',
  model: 'iPhone 16',
  orientation: 'portrait',
  buttons: [
    'home',
    'lock',
  ],
};

describe('device@1 profile', () => {
  it('has its identity and extends ui@^1', () => {
    expect(PROFILE_NAME).toBe('device');
    expect(device.id).toBe('device@1');
    expect(device.parents).toEqual({
      ui: '^1',
    });
    expect(device.definition.surface).toBe('mobile');
    expect(device.operations['ui.find']).toBe(ui.operations['ui.find']);
    expect(DEVICE_APP_KIND).toBe('device.app');
  });

  it('declares every catalog operation with its flags', () => {
    const expected: Record<string, Record<string, boolean | string>> = {
      'device.info': {
        eager: true,
      },
      'device.app.install': {
        effects: true,
        once: true,
      },
      'device.app.launch': {
        eager: true,
        effects: true,
      },
      'device.app.terminate': {
        effects: true,
      },
      'device.openUrl': {
        effects: true,
      },
      'device.button': {
        effects: true,
      },
      'device.rotate': {
        effects: true,
        optional: true,
      },
      'device.appearance': {
        effects: true,
        optional: true,
      },
      'device.logs': {
        optional: true,
        sense: 'log',
      },
      'device.test.run': {
        effects: true,
        once: true,
        optional: true,
      },
    };
    const own = Object.keys(device.operations).filter((n) => n.startsWith('device.'));
    expect(own.sort()).toEqual(Object.keys(expected).sort());
    for (const [name, flags] of Object.entries(expected)) {
      expect({
        name,
        flags: flagsOf(device, name),
      }).toEqual({
        name,
        flags,
      });
    }
  });

  it('device.info', () => {
    checkOperation(device, 'device.info', {
      input: {},
      badInput: 'info',
      output: info,
      badOutput: {
        ...info,
        orientation: 'diagonal',
      },
    });
    expect(
      DeviceInfoSchema.safeParse({
        ...info,
        buttons: [
          '',
        ],
      }).success,
    ).toBe(false);
  });

  it('device.app.install and device.app.launch', () => {
    checkOperation(device, 'device.app.install', {
      input: {
        path: '/build/App.app',
      },
      badInput: {
        path: '',
      },
      output: {
        app: appRef,
        receipt: receiptOf(),
      },
      badOutput: {
        app: appRef,
      },
    });
    checkOperation(device, 'device.app.launch', {
      input: {
        bundleId: 'com.example.app',
      },
      badInput: {
        app: appRef,
        bundleId: 'com.example.app',
      },
      output: {
        app: appRef,
        receipt: receiptOf(),
      },
      badOutput: {
        receipt: receiptOf(),
      },
    });
    const launch = device.operations['device.app.launch'];
    expect(
      launch?.input.safeParse({
        app: appRef,
      }).success,
    ).toBe(true);
    expect(launch?.input.safeParse({}).success).toBe(false);
  });

  it('device.app.terminate, device.openUrl and device.button', () => {
    checkOperation(device, 'device.app.terminate', {
      input: {
        app: appRef,
      },
      badInput: {
        app: 'com.example.app',
      },
      output: done,
      badOutput: {},
    });
    checkOperation(device, 'device.openUrl', {
      input: {
        url: 'myapp://orders/1',
      },
      badInput: {
        url: '',
      },
      output: done,
      badOutput: {},
    });
    checkOperation(device, 'device.button', {
      input: {
        name: 'home',
      },
      badInput: {},
      output: done,
      badOutput: {},
    });
  });

  it('device.rotate and device.appearance', () => {
    checkOperation(device, 'device.rotate', {
      input: {
        orientation: 'landscape-left',
      },
      badInput: {
        orientation: 'sideways',
      },
      output: done,
      badOutput: {},
    });
    checkOperation(device, 'device.appearance', {
      input: {
        appearance: 'dark',
      },
      badInput: {
        appearance: 'dim',
      },
      output: done,
      badOutput: {},
    });
  });

  it('device.logs and device.test.run', () => {
    checkOperation(device, 'device.logs', {
      input: {
        app: appRef,
        since: 'c1',
      },
      badInput: {
        app: 'x',
      },
      output: {
        lines: [
          {
            summary: 'error boom',
            level: 'error',
            text: 'boom',
          },
        ],
      },
      badOutput: {
        lines: [
          {
            level: 'error',
          },
        ],
      },
    });
    checkOperation(device, 'device.test.run', {
      input: {
        plan: 'Smoke',
      },
      badInput: {
        plan: '',
      },
      output: {
        passed: 3,
        failed: 0,
        report: blobOf('application/xml'),
        receipt: receiptOf(),
      },
      badOutput: {
        passed: 3,
        failed: 0,
        receipt: receiptOf(),
      },
    });
  });

  it('declares its read, event and setup', () => {
    expect(device.reads['device.summary']?.look).toBe('turn');
    expect(
      DeviceSummarySchema.safeParse({
        platform: 'ios',
        model: 'iPhone',
        orientation: 'portrait',
        foreground: {
          app: appRef,
          bundleId: 'com.x',
        },
      }).success,
    ).toBe(true);
    expect(
      DeviceSummarySchema.safeParse({
        platform: 'ios',
        model: 'iPhone',
        orientation: 'up',
      }).success,
    ).toBe(false);
    const crashed = device.events['device.app.crashed'];
    assert(crashed);
    expect([
      crashed.sense,
      crashed.replay,
      crashed.required,
    ]).toEqual([
      'log',
      'durable',
      undefined,
    ]);
    expect(
      crashed.payload.safeParse({
        bundleId: 'com.x',
        summary: 'error crashed',
        report: blobOf('text/plain'),
      }).success,
    ).toBe(true);
    expect(
      crashed.payload.safeParse({
        bundleId: '',
        summary: 'x',
      }).success,
    ).toBe(false);
    const setup = device.definition.setup.schema;
    expect(
      setup.safeParse({
        model: 'iPhone 16',
        osVersion: '18.0',
      }).success,
    ).toBe(true);
    expect(
      setup.safeParse({
        model: '',
      }).success,
    ).toBe(false);
  });
});
