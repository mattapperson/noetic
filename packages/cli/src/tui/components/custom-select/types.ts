/**
 * Shared types for the CustomSelect components.
 *
 * Ported from ~/Desktop/claude-code-main/src/components/CustomSelect/ against
 * stock Ink 7 + Noetic's theme (the reference uses a custom Ink fork + its
 * own design system).
 */

import type { ReactNode } from 'react';

//#region Option Types

interface BaseOption<T> {
  /** Display label. */
  label: ReactNode;
  /** Explanatory description shown under the label (or inline when `inlineDescription`). */
  description?: string;
  /** The opaque value returned on selection. */
  value: T;
  /** When true, the option is rendered dim and cannot be selected. */
  disabled?: boolean;
}

interface TextOption<T> extends BaseOption<T> {
  type?: 'text';
}

interface InputOption<T> extends BaseOption<T> {
  type: 'input';
  /** Called on every keystroke in the text input. */
  onChange: (value: string) => void;
  placeholder?: string;
  initialValue?: string;
  /**
   * When true, submitting an empty input calls the select's `onChange` rather
   * than `onCancel`. Use when empty = valid answer.
   */
  allowEmptySubmitToCancel?: boolean;
}

export type Option<T = string> = TextOption<T> | InputOption<T>;

//#endregion
