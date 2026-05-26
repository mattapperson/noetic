import type { Action } from './actions.js';
import { ACTIONS } from './actions.js';
import type { KeyBinding } from './match-binding.js';

export const DEFAULT_BINDINGS: Readonly<Record<Action, KeyBinding | KeyBinding[]>> = {
  [ACTIONS.AppInterrupt]: {
    key: 'c',
    ctrl: true,
  },
  [ACTIONS.ChatCancel]: {
    key: 'escape',
  },
};
