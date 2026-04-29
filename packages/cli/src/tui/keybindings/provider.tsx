import type { Key } from 'ink';
import { useInput } from 'ink';
import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { DEFAULT_BINDINGS } from './default-bindings.js';
import type { KeyEvent } from './match-binding.js';
import { KeybindingRegistry } from './registry.js';
import { RESERVED_ACTIONS } from './reserved.js';

const KeybindingContext = createContext<KeybindingRegistry | null>(null);

function inkKeyToEvent(input: string, key: Key): KeyEvent {
  return {
    input,
    escape: !!key.escape,
    ctrl: !!key.ctrl,
    shift: !!key.shift,
    meta: !!key.meta,
    return: !!key.return,
    tab: !!key.tab,
    backspace: !!key.backspace,
    delete: !!key.delete,
    upArrow: !!key.upArrow,
    downArrow: !!key.downArrow,
    leftArrow: !!key.leftArrow,
    rightArrow: !!key.rightArrow,
  };
}

export function KeybindingProvider({ children }: { children: ReactNode }): ReactNode {
  const registry = useMemo(
    () =>
      new KeybindingRegistry({
        bindings: DEFAULT_BINDINGS,
        reserved: RESERVED_ACTIONS,
      }),
    [],
  );

  useInput((input, key) => {
    registry.dispatch(inkKeyToEvent(input, key));
  });

  return <KeybindingContext.Provider value={registry}>{children}</KeybindingContext.Provider>;
}

export function useKeybindingRegistry(): KeybindingRegistry {
  const ctx = useContext(KeybindingContext);
  if (ctx === null) {
    throw new Error('useKeybindingRegistry must be used inside <KeybindingProvider>');
  }
  return ctx;
}
