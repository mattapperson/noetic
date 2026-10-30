import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { parseSenseMatcher, ui } from '@noetic-tools/profile-ui';
import { profileFieldOf } from '@noetic-tools/types';
import { z } from 'zod';
import {
  artifactSense,
  BROWSER_TAB_KIND,
  BrowserPageSummarySchema,
  BrowserSetupSchema,
  browser,
  browserSenseGrammars,
  formatArtifactSummary,
  PROFILE_NAME,
} from '../src/index';
import { blobOf, checkOperation, flagsOf, receiptOf, refOf } from './_helpers';

const tab = refOf('browser.tab');
const dialog = refOf('browser.dialog');
const done = {
  receipt: receiptOf(),
};
const noReceipt = {};

describe('browser@1 profile', () => {
  it('has its identity and extends ui@^1', () => {
    expect(PROFILE_NAME).toBe('browser');
    expect(browser.id).toBe('browser@1');
    expect(browser.parents).toEqual({
      ui: '^1',
    });
    expect(browser.definition.surface).toBe('web');
    expect(browser.definition.determinism).toEqual({
      reset: 'cheap',
      replayPrefix: 'free',
      time: 'wall',
      observation: 'exact',
      actions: 'reversible',
    });
  });

  it('inherits every ui operation, read and event unchanged', () => {
    for (const name of Object.keys(ui.operations)) {
      expect(browser.operations[name]).toBe(ui.operations[name]);
    }
    expect(browser.reads['ui.summary']).toBe(ui.reads['ui.summary']);
    expect(browser.events['ui.changed']).toBe(ui.events['ui.changed']);
  });

  it('declares every catalog operation with its flags', () => {
    const expected: Record<string, Record<string, boolean | string>> = {
      'browser.navigate': {
        eager: true,
        effects: true,
      },
      'browser.back': {
        effects: true,
      },
      'browser.forward': {
        effects: true,
      },
      'browser.reload': {
        effects: true,
      },
      'browser.tabs': {},
      'browser.tab.open': {
        effects: true,
      },
      'browser.tab.close': {
        effects: true,
      },
      'browser.tab.select': {
        effects: true,
      },
      'browser.dialog.respond': {
        effects: true,
      },
      'browser.requests': {
        optional: true,
        sense: 'net',
      },
      'browser.console': {
        optional: true,
        sense: 'log',
      },
      'browser.state': {
        optional: true,
        sense: 'state',
      },
      'browser.evaluate': {
        optional: true,
        guarded: true,
      },
    };
    const own = Object.keys(browser.operations).filter((n) => n.startsWith('browser.'));
    expect(own.sort()).toEqual(Object.keys(expected).sort());
    for (const [name, flags] of Object.entries(expected)) {
      expect({
        name,
        flags: flagsOf(browser, name),
      }).toEqual({
        name,
        flags,
      });
    }
  });

  it('marks tab refs volatile and dialog refs volatile', () => {
    const open = browser.operations['browser.tab.open'];
    assert(open?.output instanceof z.ZodObject);
    expect(profileFieldOf(open.output.shape.tab)).toEqual({
      kind: 'ref',
      refKind: BROWSER_TAB_KIND,
      volatile: true,
      public: false,
    });
    const respond = browser.operations['browser.dialog.respond'];
    assert(respond?.input instanceof z.ZodObject);
    expect(profileFieldOf(respond.input.shape.dialog)).toMatchObject({
      kind: 'ref',
      refKind: 'browser.dialog',
      volatile: true,
    });
  });

  it('browser.navigate', () => {
    checkOperation(browser, 'browser.navigate', {
      input: {
        url: 'http://localhost:5173/',
        tab,
      },
      badInput: {
        url: '',
      },
      output: {
        url: 'http://localhost:5173/',
        title: 'Shop',
        receipt: receiptOf(),
      },
      badOutput: {
        url: 'http://localhost:5173/',
        title: 'Shop',
      },
    });
  });

  it('browser.back, forward and reload', () => {
    for (const name of [
      'browser.back',
      'browser.forward',
      'browser.reload',
    ]) {
      checkOperation(browser, name, {
        input: {
          tab,
        },
        badInput: {
          tab: 'first tab',
        },
        output: {
          url: '/',
          receipt: receiptOf(),
        },
        badOutput: {
          url: '/',
        },
      });
      expect(browser.operations[name]?.input.safeParse({}).success).toBe(true);
    }
  });

  it('browser.tabs', () => {
    checkOperation(browser, 'browser.tabs', {
      input: {},
      badInput: 'all tabs',
      output: {
        tabs: [
          {
            tab,
            url: '/',
            title: 'Home',
            active: true,
          },
        ],
      },
      badOutput: {
        tabs: [
          {
            tab,
            url: '/',
            title: 'Home',
          },
        ],
      },
    });
  });

  it('browser.tab.open, close and select', () => {
    checkOperation(browser, 'browser.tab.open', {
      input: {
        url: 'http://x.test/',
      },
      badInput: {
        url: '',
      },
      output: {
        tab,
        receipt: receiptOf(),
      },
      badOutput: {
        tab,
      },
    });
    for (const name of [
      'browser.tab.close',
      'browser.tab.select',
    ]) {
      checkOperation(browser, name, {
        input: {
          tab,
        },
        badInput: {},
        output: {
          tab,
          receipt: receiptOf(),
        },
        badOutput: {
          receipt: receiptOf(),
        },
      });
    }
  });

  it('browser.dialog.respond', () => {
    checkOperation(browser, 'browser.dialog.respond', {
      input: {
        dialog,
        accept: true,
        text: 'yes',
      },
      badInput: {
        dialog: tab,
        accept: true,
      },
      output: done,
      badOutput: noReceipt,
    });
  });

  it('browser.requests filters by a net matcher', () => {
    const request = {
      summary: 'POST /api/orders 201',
      method: 'POST',
      url: 'http://x.test/api/orders',
      status: 201,
      timing: {
        startMs: 10,
        durationMs: 40,
      },
    };
    checkOperation(browser, 'browser.requests', {
      input: {
        since: 'c1',
        actionId: 'act-1',
        filter: 'POST /api/* 5xx',
      },
      badInput: {
        filter: 'post /api',
      },
      output: {
        requests: [
          request,
          {
            ...request,
            status: null,
            timing: {
              startMs: 0,
            },
          },
        ],
      },
      badOutput: {
        requests: [
          {
            ...request,
            timing: undefined,
          },
        ],
      },
    });
  });

  it('browser.console', () => {
    checkOperation(browser, 'browser.console', {
      input: {
        level: 'error',
      },
      badInput: {
        level: '',
      },
      output: {
        messages: [
          {
            summary: 'error boom',
            level: 'error',
            text: 'boom',
          },
        ],
      },
      badOutput: {
        messages: [
          {
            level: 'error',
            text: 'boom',
          },
        ],
      },
    });
  });

  it('browser.state and browser.evaluate', () => {
    checkOperation(browser, 'browser.state', {
      input: {
        path: 'cart.total',
      },
      badInput: {
        path: '',
      },
      output: {
        value: 42,
      },
      badOutput: 'not an object',
    } as const);
    checkOperation(browser, 'browser.evaluate', {
      input: {
        expression: 'document.title',
        tab,
      },
      badInput: {
        expression: '',
      },
      output: {
        value: 'Shop',
      },
      badOutput: 'not an object',
    } as const);
  });

  it('declares its reads', () => {
    expect(browser.reads['browser.page.summary']?.look).toBe('turn');
    expect(browser.reads['browser.page.summary']?.sense).toBe('route');
    expect(browser.reads['browser.page']?.look).toBe('effect');
    expect(
      BrowserPageSummarySchema.safeParse({
        url: '/',
        title: 'T',
        route: '/',
      }).success,
    ).toBe(true);
    expect(
      BrowserPageSummarySchema.safeParse({
        url: '/',
        title: 'T',
      }).success,
    ).toBe(false);
    const page = browser.reads['browser.page'];
    expect(
      page?.schema.safeParse({
        url: '/',
        title: 'T',
        route: '/',
        tree: {
          element: refOf('ui.element'),
          role: 'main',
          name: '',
        },
      }).success,
    ).toBe(true);
  });

  it('declares every event live with an actionId argument and its sense', () => {
    const expected: Record<
      string,
      {
        sense: string;
        optional: boolean;
      }
    > = {
      'browser.page.loaded': {
        sense: 'route',
        optional: false,
      },
      'browser.dialog.opened': {
        sense: 'ui',
        optional: false,
      },
      'browser.request': {
        sense: 'net',
        optional: true,
      },
      'browser.console.message': {
        sense: 'log',
        optional: true,
      },
      'browser.signal': {
        sense: 'signal',
        optional: true,
      },
      'browser.download': {
        sense: 'x-artifact',
        optional: true,
      },
    };
    const own = Object.keys(browser.events).filter((n) => n.startsWith('browser.'));
    expect(own.sort()).toEqual(Object.keys(expected).sort());
    for (const [name, want] of Object.entries(expected)) {
      const event = browser.events[name];
      assert(event);
      expect({
        name,
        sense: String(event.sense),
        optional: event.required === false,
        replay: event.replay,
      }).toEqual({
        name,
        ...want,
        replay: 'live',
      });
      expect(
        event.arguments?.safeParse({
          actionId: 'act-1',
        }).success,
      ).toBe(true);
      expect(
        event.arguments?.safeParse({
          actionId: '',
        }).success,
      ).toBe(false);
    }
  });

  it('validates event payloads', () => {
    const loaded = browser.events['browser.page.loaded'];
    expect(
      loaded?.payload.safeParse({
        tab,
        url: '/done',
        summary: '/done',
      }).success,
    ).toBe(true);
    expect(
      loaded?.payload.safeParse({
        url: '/done',
      }).success,
    ).toBe(false);
    const opened = browser.events['browser.dialog.opened'];
    expect(
      opened?.payload.safeParse({
        dialog,
        type: 'confirm',
        message: 'Sure?',
        summary: 'dialog "Sure?"',
      }).success,
    ).toBe(true);
    expect(
      opened?.payload.safeParse({
        dialog,
        type: 'modal',
        message: 'x',
        summary: 'x',
      }).success,
    ).toBe(false);
    const signal = browser.events['browser.signal'];
    expect(
      signal?.payload.safeParse({
        name: 'order.placed',
        summary: 'order.placed',
      }).success,
    ).toBe(true);
    expect(
      signal?.payload.safeParse({
        name: '',
        summary: '',
      }).success,
    ).toBe(false);
    const download = browser.events['browser.download'];
    expect(
      download?.payload.safeParse({
        filename: 'a.pdf',
        file: blobOf('application/pdf'),
        summary: 'download "a.pdf"',
      }).success,
    ).toBe(true);
    expect(
      download?.payload.safeParse({
        filename: 'a.pdf',
        summary: 'x',
      }).success,
    ).toBe(false);
  });

  it('validates setup', () => {
    expect(
      BrowserSetupSchema.safeParse({
        url: 'http://localhost:5173',
        session: blobOf('application/json'),
        viewport: {
          width: 1280,
          height: 720,
        },
        locale: 'en-US',
        timezone: 'UTC',
      }).success,
    ).toBe(true);
    expect(BrowserSetupSchema.safeParse({}).success).toBe(true);
    expect(
      BrowserSetupSchema.safeParse({
        viewport: {
          width: 0,
          height: 1,
        },
      }).success,
    ).toBe(false);
    expect(browser.definition.setup.schema).toBe(BrowserSetupSchema);
  });

  it('declares the x-artifact sense', () => {
    expect(browser.definition.senses['x-artifact']).toEqual({
      independence: 'independent',
      grade: 'consequence',
      note: 'A file the browser downloaded, carried as a blob.',
    });
  });
});

describe('x-artifact sense', () => {
  function parse(text: string): ReturnType<typeof parseSenseMatcher> {
    return parseSenseMatcher('x-artifact', text, browserSenseGrammars);
  }

  it('formats download "filename"', () => {
    expect(formatArtifactSummary('report "q3".pdf')).toBe('download "report \\"q3\\".pdf"');
    expect(artifactSense.summaryFormat).toBe('download "filename"');
  });

  it('matches any download, a filename, or a filename glob', () => {
    const any = parse('download');
    assert(any.ok);
    expect(any.matcher.summary).toBeUndefined();
    expect(
      any.matcher.matches({
        summary: 'download "a.pdf"',
      }),
    ).toBe(true);
    expect(
      any.matcher.matches({
        summary: 'download',
      }),
    ).toBe(false);
    expect(
      any.matcher.matches({
        summary: 'upload "a.pdf"',
      }),
    ).toBe(false);

    const exact = parse('download "a.pdf"');
    assert(exact.ok);
    expect(exact.matcher.summary).toBe('download "a.pdf"');
    expect(
      exact.matcher.matches({
        summary: 'download "a.pdf"',
      }),
    ).toBe(true);
    expect(
      exact.matcher.matches({
        summary: 'download "b.pdf"',
      }),
    ).toBe(false);

    const glob = parse('download "report-*.csv"');
    assert(glob.ok);
    expect(glob.matcher.summary).toBeUndefined();
    expect(
      glob.matcher.matches({
        summary: 'download "report-2026.csv"',
      }),
    ).toBe(true);
    expect(
      glob.matcher.matches({
        summary: 'download "report-2026.pdf"',
      }),
    ).toBe(false);
    expect(
      glob.matcher.matches({
        summary: 'download "reportX2026.csv"',
      }),
    ).toBe(false);
  });

  it('refuses malformed matchers', () => {
    for (const text of [
      '',
      'upload',
      'download a.pdf',
      'download "a" "b"',
      'download "a',
      '"download"',
    ]) {
      const result = parse(text);
      expect({
        text,
        ok: result.ok,
      }).toEqual({
        text,
        ok: false,
      });
    }
  });
});
