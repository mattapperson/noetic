import type { KeyBinding, KeyEvent } from './match-binding.js';
import { matchBinding } from './match-binding.js';

export type Action = string;
export type KeyHandler = () => void;

export type KeybindingRegistryOptions = {
  bindings: Readonly<Record<Action, KeyBinding | KeyBinding[]>>;
  reserved?: ReadonlySet<Action>;
};

/**
 * Maps action names to bindings and dispatches key events to registered
 * handlers.
 *
 * Handlers fire in last-registered-first order, mirroring Claude Code's
 * priority pattern — the most-recently-mounted component wins. Since
 * mounted React components register on commit, "deepest in the tree last
 * to commit" naturally maps to "highest priority".
 */
export class KeybindingRegistry {
  readonly #bindings: Map<Action, KeyBinding[]>;
  readonly #reserved: ReadonlySet<Action>;
  readonly #handlers: Map<Action, KeyHandler[]>;

  constructor(options: KeybindingRegistryOptions) {
    this.#bindings = new Map();
    for (const [action, binding] of Object.entries(options.bindings)) {
      this.#bindings.set(action, normalizeBindings(binding));
    }
    this.#reserved = options.reserved ?? new Set();
    this.#handlers = new Map();
  }

  setBinding(action: Action, binding: KeyBinding | KeyBinding[]): void {
    if (this.#reserved.has(action)) {
      throw new Error(`Cannot rebind reserved action: ${action}`);
    }
    if (!this.#bindings.has(action)) {
      throw new Error(`Unknown action: ${action}`);
    }
    this.#bindings.set(action, normalizeBindings(binding));
  }

  register(action: Action, handler: KeyHandler): () => void {
    if (!this.#bindings.has(action)) {
      throw new Error(`Unknown action: ${action}`);
    }
    const list = this.#handlers.get(action) ?? [];
    list.push(handler);
    this.#handlers.set(action, list);
    return () => {
      const current = this.#handlers.get(action);
      if (!current) {
        return;
      }
      const idx = current.indexOf(handler);
      if (idx === -1) {
        return;
      }
      current.splice(idx, 1);
    };
  }

  dispatch(event: KeyEvent): void {
    for (const [action, bindings] of this.#bindings) {
      if (!bindings.some((b) => matchBinding(event, b))) {
        continue;
      }
      const handlers = this.#handlers.get(action);
      if (!handlers || handlers.length === 0) {
        return;
      }
      // Iterate in reverse so the most-recently-registered handler runs
      // first (LIFO priority).
      for (let i = handlers.length - 1; i >= 0; i--) {
        handlers[i]?.();
      }
      return;
    }
  }
}

function normalizeBindings(binding: KeyBinding | KeyBinding[]): KeyBinding[] {
  return Array.isArray(binding)
    ? [
        ...binding,
      ]
    : [
        binding,
      ];
}
