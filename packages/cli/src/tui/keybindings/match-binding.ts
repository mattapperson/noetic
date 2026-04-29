/**
 * Pure key-event matcher.
 *
 * The Ink-side `useKeybinding` hook reads the live key event and asks
 * `matchBinding` whether each registered action's binding fires. Keeping
 * this match logic pure makes the keybinding tier exhaustively testable
 * without needing an Ink renderer.
 *
 * Future work (deliberately out of this initial port):
 *   - Chord support (e.g. Ctrl+G then Ctrl+S) — the registry layer would
 *     own the chord buffer; this matcher remains single-key.
 *   - Context routing — bindings scoped to a screen/region. Today the
 *     hook itself controls activation via an `enabled` flag.
 */

export type KeyName =
  | 'escape'
  | 'tab'
  | 'enter'
  | 'backspace'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | string;

export type KeyBinding = {
  key: KeyName;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
};

export type KeyEvent = {
  input: string;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  return: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
};

const NAMED_KEYS: Record<string, (event: KeyEvent) => boolean> = {
  escape: (e) => e.escape,
  tab: (e) => e.tab,
  enter: (e) => e.return,
  backspace: (e) => e.backspace,
  delete: (e) => e.delete,
  up: (e) => e.upArrow,
  down: (e) => e.downArrow,
  left: (e) => e.leftArrow,
  right: (e) => e.rightArrow,
};

function isNamedKey(name: string): boolean {
  return Object.hasOwn(NAMED_KEYS, name);
}

function matchKeyName(event: KeyEvent, binding: KeyBinding): boolean {
  const name = binding.key.toLowerCase();
  const namedMatcher = NAMED_KEYS[name];
  if (namedMatcher) {
    return namedMatcher(event);
  }
  // Free-form character key — case-insensitive single-char match.
  return event.input.toLowerCase() === name;
}

function modifiersMatch(event: KeyEvent, binding: KeyBinding): boolean {
  if (binding.ctrl !== undefined && binding.ctrl !== event.ctrl) {
    return false;
  }
  // Shift is implicit for many keys (capital letters, !, etc.); only
  // enforce strict match when the binding explicitly opts in.
  if (binding.shift !== undefined && binding.shift !== event.shift) {
    return false;
  }
  if (binding.meta !== undefined && binding.meta !== event.meta) {
    return false;
  }
  // When the binding doesn't specify ctrl/meta, require they're absent —
  // otherwise plain `{ key: 'c' }` would match Ctrl+C, which would let
  // every text key collide with chord shortcuts.
  if (binding.ctrl === undefined && event.ctrl) {
    return false;
  }
  if (binding.meta === undefined && event.meta) {
    return false;
  }
  return true;
}

export function matchBinding(event: KeyEvent, binding: KeyBinding): boolean {
  if (!isNamedKey(binding.key.toLowerCase()) && binding.key.length !== 1) {
    return false;
  }
  if (!matchKeyName(event, binding)) {
    return false;
  }
  return modifiersMatch(event, binding);
}
