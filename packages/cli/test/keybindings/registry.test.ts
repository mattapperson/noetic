import { describe, expect, mock, test } from 'bun:test';
import type { KeyEvent } from '../../src/tui/keybindings/match-binding.js';
import { KeybindingRegistry } from '../../src/tui/keybindings/registry.js';

const PLAIN: KeyEvent = {
  input: '',
  escape: false,
  ctrl: false,
  shift: false,
  meta: false,
  return: false,
  tab: false,
  backspace: false,
  delete: false,
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
};

function event(overrides: Partial<KeyEvent>): KeyEvent {
  return {
    ...PLAIN,
    ...overrides,
  };
}

describe('KeybindingRegistry', () => {
  test('dispatch fires handler when event matches the action binding', () => {
    const reg = new KeybindingRegistry({
      bindings: {
        'app:interrupt': {
          key: 'c',
          ctrl: true,
        },
      },
    });
    const handler = mock(() => {});
    reg.register('app:interrupt', handler);
    reg.dispatch(
      event({
        input: 'c',
        ctrl: true,
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('dispatch ignores events that do not match any binding', () => {
    const reg = new KeybindingRegistry({
      bindings: {
        'app:interrupt': {
          key: 'c',
          ctrl: true,
        },
      },
    });
    const handler = mock(() => {});
    reg.register('app:interrupt', handler);
    reg.dispatch(
      event({
        input: 'x',
      }),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  test('multiple handlers for one action all fire (LIFO order)', () => {
    const reg = new KeybindingRegistry({
      bindings: {
        'chat:cancel': {
          key: 'escape',
        },
      },
    });
    const order: string[] = [];
    reg.register('chat:cancel', () => order.push('first'));
    reg.register('chat:cancel', () => order.push('second'));
    reg.dispatch(
      event({
        escape: true,
      }),
    );
    expect(order).toEqual([
      'second',
      'first',
    ]);
  });

  test('unregister returned by register() removes the handler', () => {
    const reg = new KeybindingRegistry({
      bindings: {
        'app:interrupt': {
          key: 'c',
          ctrl: true,
        },
      },
    });
    const handler = mock(() => {});
    const dispose = reg.register('app:interrupt', handler);
    dispose();
    reg.dispatch(
      event({
        input: 'c',
        ctrl: true,
      }),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  test('action with multiple bindings fires on any of them', () => {
    const reg = new KeybindingRegistry({
      bindings: {
        'history:prev': [
          {
            key: 'up',
          },
          {
            key: 'p',
            ctrl: true,
          },
        ],
      },
    });
    const handler = mock(() => {});
    reg.register('history:prev', handler);
    reg.dispatch(
      event({
        upArrow: true,
      }),
    );
    reg.dispatch(
      event({
        input: 'p',
        ctrl: true,
      }),
    );
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('setBinding overrides defaults when action is not reserved', () => {
    const reg = new KeybindingRegistry({
      bindings: {
        'history:prev': {
          key: 'up',
        },
      },
      reserved: new Set([
        'app:interrupt',
      ]),
    });
    reg.setBinding('history:prev', {
      key: 'k',
      ctrl: true,
    });
    const handler = mock(() => {});
    reg.register('history:prev', handler);
    reg.dispatch(
      event({
        upArrow: true,
      }),
    );
    expect(handler).not.toHaveBeenCalled();
    reg.dispatch(
      event({
        input: 'k',
        ctrl: true,
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('setBinding on a reserved action throws', () => {
    const reg = new KeybindingRegistry({
      bindings: {
        'app:interrupt': {
          key: 'c',
          ctrl: true,
        },
      },
      reserved: new Set([
        'app:interrupt',
      ]),
    });
    expect(() =>
      reg.setBinding('app:interrupt', {
        key: 'q',
      }),
    ).toThrow(/reserved/i);
  });

  test('register on undefined action throws', () => {
    const reg = new KeybindingRegistry({
      bindings: {
        'chat:cancel': {
          key: 'escape',
        },
      },
    });
    expect(() => reg.register('does:not-exist', () => {})).toThrow(/unknown action/i);
  });

  test('dispatch is a no-op when no handlers registered for matched action', () => {
    const reg = new KeybindingRegistry({
      bindings: {
        'app:interrupt': {
          key: 'c',
          ctrl: true,
        },
      },
    });
    expect(() =>
      reg.dispatch(
        event({
          input: 'c',
          ctrl: true,
        }),
      ),
    ).not.toThrow();
  });
});
