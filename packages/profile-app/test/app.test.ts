import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { parseSenseMatcher, ui } from '@noetic-tools/profile-ui';
import { profileFieldOf } from '@noetic-tools/types';
import { z } from 'zod';
import {
  APP_HOST_ONLY_SETUP,
  APP_WINDOW_KIND,
  AppSetupSchema,
  AppSummarySchema,
  app,
  appSenseGrammars,
  exitSense,
  formatExitSummary,
  formatTerminationSummary,
  offersLaunchOrAttach,
  PROFILE_NAME,
  terminationSense,
} from '../src/index';
import { checkOperation, flagsOf, receiptOf, refOf } from './_helpers';

const appRef = refOf('app.app');
const windowRef = refOf('app.window');
const done = {
  receipt: receiptOf(),
};

describe('app@1 profile', () => {
  it('has its identity and extends ui@^1', () => {
    expect(PROFILE_NAME).toBe('app');
    expect(app.id).toBe('app@1');
    expect(app.parents).toEqual({
      ui: '^1',
    });
    expect(app.definition.surface).toBe('desktop');
    expect(app.operations['ui.tap']).toBe(ui.operations['ui.tap']);
  });

  it('declares every catalog operation with its flags', () => {
    const expected: Record<string, Record<string, boolean | string>> = {
      'app.launch': {
        eager: true,
        effects: true,
        optional: true,
      },
      'app.attach': {
        optional: true,
      },
      'app.windows': {
        eager: true,
      },
      'app.window.focus': {
        effects: true,
      },
      'app.terminate': {
        effects: true,
      },
      'app.state': {
        optional: true,
        sense: 'state',
      },
    };
    const own = Object.keys(app.operations).filter((n) => n.startsWith('app.'));
    expect(own.sort()).toEqual(Object.keys(expected).sort());
    for (const [name, flags] of Object.entries(expected)) {
      expect({
        name,
        flags: flagsOf(app, name),
      }).toEqual({
        name,
        flags,
      });
    }
  });

  it('a server offers launch, attach or both', () => {
    expect(
      offersLaunchOrAttach([
        'app.launch',
      ]),
    ).toBe(true);
    expect(
      offersLaunchOrAttach([
        'app.attach',
      ]),
    ).toBe(true);
    expect(
      offersLaunchOrAttach([
        'app.launch',
        'app.attach',
      ]),
    ).toBe(true);
    expect(
      offersLaunchOrAttach([
        'app.windows',
      ]),
    ).toBe(false);
  });

  it('app.launch and app.attach', () => {
    checkOperation(app, 'app.launch', {
      input: {},
      badInput: 'now',
      output: {
        app: appRef,
        receipt: receiptOf(),
      },
      badOutput: {
        app: appRef,
      },
    });
    checkOperation(app, 'app.attach', {
      input: {
        match: 'Calculator',
      },
      badInput: {
        match: '',
      },
      output: {
        app: appRef,
      },
      badOutput: {
        app: windowRef,
      },
    });
  });

  it('app.windows marks window refs volatile', () => {
    checkOperation(app, 'app.windows', {
      input: {
        app: appRef,
      },
      badInput: {
        app: 'Calculator',
      },
      output: {
        windows: [
          {
            window: windowRef,
            title: 'Main',
            focused: true,
          },
        ],
      },
      badOutput: {
        windows: [
          {
            window: windowRef,
            title: 'Main',
          },
        ],
      },
    });
    const focus = app.operations['app.window.focus'];
    assert(focus?.input instanceof z.ZodObject);
    expect(profileFieldOf(focus.input.shape.window)).toMatchObject({
      kind: 'ref',
      refKind: APP_WINDOW_KIND,
      volatile: true,
    });
  });

  it('app.window.focus, app.terminate and app.state', () => {
    checkOperation(app, 'app.window.focus', {
      input: {
        window: windowRef,
      },
      badInput: {},
      output: done,
      badOutput: {},
    });
    checkOperation(app, 'app.terminate', {
      input: {
        app: appRef,
      },
      badInput: {
        app: windowRef,
      },
      output: done,
      badOutput: {},
    });
    checkOperation(app, 'app.state', {
      input: {
        path: 'document.dirty',
      },
      badInput: {
        path: '',
      },
      output: {
        value: true,
      },
      badOutput: 'x',
    });
  });

  it('declares its read and events', () => {
    expect(app.reads['app.summary']?.look).toBe('turn');
    expect(
      AppSummarySchema.safeParse({
        app: appRef,
        name: 'Calc',
        windows: 1,
        focused: null,
      }).success,
    ).toBe(true);
    expect(
      AppSummarySchema.safeParse({
        app: null,
        name: 'Calc',
        windows: -1,
        focused: null,
      }).success,
    ).toBe(false);
    const exited = app.events['app.exited'];
    const terminated = app.events['app.terminated'];
    const signal = app.events['app.signal'];
    assert(exited && terminated && signal);
    expect([
      exited.sense,
      terminated.sense,
      signal.sense,
    ]).toEqual([
      'x-exit',
      'x-termination',
      'signal',
    ]);
    expect(exited.required).toBeUndefined();
    expect(signal.required).toBe(false);
    expect(
      exited.payload.safeParse({
        app: appRef,
        code: 1,
        summary: 'exit 1',
      }).success,
    ).toBe(true);
    expect(
      exited.payload.safeParse({
        app: appRef,
        code: 1.5,
        summary: 'exit 1',
      }).success,
    ).toBe(false);
    expect(
      terminated.payload.safeParse({
        app: appRef,
        reason: 'SIGKILL',
        summary: 'terminated SIGKILL',
      }).success,
    ).toBe(true);
    expect(
      terminated.payload.safeParse({
        app: appRef,
        reason: '',
        summary: 'x',
      }).success,
    ).toBe(false);
    expect(
      signal.payload.safeParse({
        name: 'doc.saved',
        summary: 'doc.saved',
      }).success,
    ).toBe(true);
  });

  it('declares x- senses apart: the app describing itself and the OS describing it', () => {
    expect(app.definition.senses['x-exit']?.independence).toBe('actuation-derived');
    expect(app.definition.senses['x-termination']?.independence).toBe('independent');
  });

  it('setup takes path or command, with path, command and env reserved to the host', () => {
    expect(app.definition.setup.hostOnly).toEqual(APP_HOST_ONLY_SETUP);
    expect(APP_HOST_ONLY_SETUP).toEqual([
      'path',
      'command',
      'env',
    ]);
    expect(
      AppSetupSchema.safeParse({
        path: '/Applications/Calc.app',
      }).success,
    ).toBe(true);
    expect(
      AppSetupSchema.safeParse({
        command: 'calc',
        args: [
          '-x',
        ],
        env: {
          A: '1',
        },
      }).success,
    ).toBe(true);
    expect(AppSetupSchema.safeParse({}).success).toBe(false);
    expect(
      AppSetupSchema.safeParse({
        path: '/a',
        command: 'b',
      }).success,
    ).toBe(false);
  });
});

describe('x-exit sense', () => {
  function parse(text: string): ReturnType<typeof parseSenseMatcher> {
    return parseSenseMatcher('x-exit', text, appSenseGrammars);
  }

  it('formats exit CODE', () => {
    expect(formatExitSummary(0)).toBe('exit 0');
    expect(formatExitSummary(137.9)).toBe('exit 137');
    expect(exitSense.summaryFormat).toBe('exit CODE');
  });

  it('matches any exit, a code, or nonzero', () => {
    const any = parse('exit');
    assert(any.ok);
    expect(any.matcher.summary).toBeUndefined();
    expect(
      any.matcher.matches({
        summary: 'exit 3',
      }),
    ).toBe(true);
    expect(
      any.matcher.matches({
        summary: 'exit',
      }),
    ).toBe(false);
    expect(
      any.matcher.matches({
        summary: 'exit nonzero',
      }),
    ).toBe(false);
    expect(
      any.matcher.matches({
        summary: 'terminated SIGKILL',
      }),
    ).toBe(false);

    const zero = parse('exit 0');
    assert(zero.ok);
    expect(zero.matcher.summary).toBe('exit 0');
    expect(
      zero.matcher.matches({
        summary: 'exit 0',
      }),
    ).toBe(true);
    expect(
      zero.matcher.matches({
        summary: 'exit 1',
      }),
    ).toBe(false);

    const nonzero = parse('exit nonzero');
    assert(nonzero.ok);
    expect(nonzero.matcher.summary).toBeUndefined();
    expect(
      nonzero.matcher.matches({
        summary: 'exit 1',
      }),
    ).toBe(true);
    expect(
      nonzero.matcher.matches({
        summary: 'exit -1',
      }),
    ).toBe(true);
    expect(
      nonzero.matcher.matches({
        summary: 'exit 0',
      }),
    ).toBe(false);
  });

  it('refuses malformed matchers', () => {
    for (const text of [
      '',
      'exited',
      'exit one',
      'exit 0 1',
      'exit 1.5',
    ]) {
      expect({
        text,
        ok: parse(text).ok,
      }).toEqual({
        text,
        ok: false,
      });
    }
  });
});

describe('x-termination sense', () => {
  function parse(text: string): ReturnType<typeof parseSenseMatcher> {
    return parseSenseMatcher('x-termination', text, appSenseGrammars);
  }

  it('formats terminated REASON', () => {
    expect(formatTerminationSummary('SIGKILL')).toBe('terminated SIGKILL');
    expect(formatTerminationSummary('out of memory')).toBe('terminated out-of-memory');
    expect(formatTerminationSummary('  ')).toBe('terminated unknown');
    expect(terminationSense.summaryFormat).toBe('terminated REASON');
  });

  it('matches any termination or a reason', () => {
    const any = parse('terminated');
    assert(any.ok);
    expect(any.matcher.summary).toBeUndefined();
    expect(
      any.matcher.matches({
        summary: 'terminated oom',
      }),
    ).toBe(true);
    expect(
      any.matcher.matches({
        summary: 'terminated',
      }),
    ).toBe(false);
    expect(
      any.matcher.matches({
        summary: 'exit 0',
      }),
    ).toBe(false);

    const kill = parse('terminated SIGKILL');
    assert(kill.ok);
    expect(kill.matcher.summary).toBe('terminated SIGKILL');
    expect(
      kill.matcher.matches({
        summary: 'terminated SIGKILL',
      }),
    ).toBe(true);
    expect(
      kill.matcher.matches({
        summary: 'terminated SIGTERM',
      }),
    ).toBe(false);
  });

  it('refuses malformed matchers', () => {
    for (const text of [
      '',
      'killed',
      'terminated a b',
      'terminated "x"',
    ]) {
      expect({
        text,
        ok: parse(text).ok,
      }).toEqual({
        text,
        ok: false,
      });
    }
  });
});
