/**
 * Action names recognised by the keybinding registry.
 *
 * Adding a new action: append the literal here, add a default binding in
 * `default-bindings.ts`, and (if it must not be rebindable) add it to the
 * `RESERVED_ACTIONS` set in `reserved.ts`.
 */
export const ACTIONS = {
  /** First-press: cancel in-flight turn. Second-press within window: exit. */
  AppInterrupt: 'app:interrupt',
  /** Cancel the current chat turn (Escape). Stays in the TUI. */
  ChatCancel: 'chat:cancel',
} as const;

export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];
