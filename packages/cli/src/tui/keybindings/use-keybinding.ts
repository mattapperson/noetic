import { useEffect } from 'react';
import type { Action } from './actions.js';
import { useKeybindingRegistry } from './provider.js';

export type UseKeybindingOptions = {
  enabled?: boolean;
};

/**
 * Register a handler for a keybinding action. The handler is unregistered
 * automatically on unmount or when `enabled` flips to false.
 *
 * The handler receives no event object — the keybinding system pre-matches
 * the action, so the caller already knows which key fired. Components that
 * need access to the raw key (e.g. text input) should keep using
 * `useInput` directly.
 */
export function useKeybinding(
  action: Action,
  handler: () => void,
  options: UseKeybindingOptions = {},
): void {
  const registry = useKeybindingRegistry();
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return registry.register(action, handler);
  }, [
    action,
    handler,
    enabled,
    registry,
  ]);
}
