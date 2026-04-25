/**
 * Multi-select variant — Space toggles the focused option, Enter submits the
 * current set, Esc cancels.
 *
 * Ported from ~/Desktop/claude-code-main/src/components/CustomSelect/SelectMulti.tsx.
 */

import { Box, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SelectOption } from './select-option.js';
import type { Option } from './types.js';

//#region Props

export interface SelectMultiProps<T> {
  readonly options: ReadonlyArray<Option<T>>;
  readonly isDisabled?: boolean;
  readonly hideIndexes?: boolean;
  readonly inlineDescription?: boolean;
  readonly defaultValue?: ReadonlyArray<T>;
  readonly onChange?: (values: ReadonlyArray<T>) => void;
  readonly onSubmit?: (values: ReadonlyArray<T>) => void;
  readonly onCancel?: () => void;
  readonly onFocus?: (value: T) => void;
  readonly focusValue?: T;
}

//#endregion

//#region Component

function sanitizeIndex(index: number, length: number): number {
  if (length === 0) {
    return 0;
  }
  return ((index % length) + length) % length;
}

function findValueIndex<T>(options: ReadonlyArray<Option<T>>, value: T | undefined): number {
  if (value === undefined) {
    return -1;
  }
  return options.findIndex((opt) => opt.value === value);
}

export function SelectMulti<T>({
  options,
  isDisabled,
  hideIndexes,
  inlineDescription,
  defaultValue,
  onChange,
  onSubmit,
  onCancel,
  onFocus,
  focusValue,
}: SelectMultiProps<T>) {
  const [selected, setSelected] = useState<ReadonlyArray<T>>(defaultValue ?? []);
  const initialIndex = useMemo(
    () => Math.max(0, findValueIndex(options, focusValue)),
    [
      options,
      focusValue,
    ],
  );
  const [focusedIndex, setFocusedIndex] = useState(initialIndex);

  useEffect(() => {
    if (focusValue === undefined) {
      return;
    }
    const idx = findValueIndex(options, focusValue);
    if (idx >= 0 && idx !== focusedIndex) {
      setFocusedIndex(idx);
    }
  }, [
    focusValue,
    options,
    focusedIndex,
  ]);

  // Same fire-on-change guard as `Select`: avoid notifying on every render
  // when the consumer passes an inline-arrow `onFocus`.
  const lastFiredFocusRef = useRef<T | undefined>(undefined);
  useEffect(() => {
    const val = options[focusedIndex]?.value;
    if (val === undefined) {
      return;
    }
    if (lastFiredFocusRef.current === val) {
      return;
    }
    lastFiredFocusRef.current = val;
    onFocus?.(val);
  }, [
    focusedIndex,
    options,
    onFocus,
  ]);

  const moveFocus = useCallback(
    (delta: number) => {
      if (options.length === 0) {
        return;
      }
      setFocusedIndex((idx) => {
        let next = sanitizeIndex(idx + delta, options.length);
        let attempts = 0;
        while (options[next]?.disabled && attempts < options.length) {
          next = sanitizeIndex(next + Math.sign(delta || 1), options.length);
          attempts += 1;
        }
        return next;
      });
    },
    [
      options,
    ],
  );

  const toggle = useCallback(
    (value: T) => {
      setSelected((prev) => {
        const next = prev.includes(value)
          ? prev.filter((v) => v !== value)
          : [
              ...prev,
              value,
            ];
        onChange?.(next);
        return next;
      });
    },
    [
      onChange,
    ],
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.downArrow || input === 'j') {
        moveFocus(1);
        return;
      }
      if (key.upArrow || input === 'k') {
        moveFocus(-1);
        return;
      }
      if (key.return) {
        onSubmit?.(selected);
        return;
      }
      if (input === ' ') {
        const opt = options[focusedIndex];
        if (opt && !opt.disabled && opt.type !== 'input') {
          toggle(opt.value);
        }
        return;
      }
      if (/^[1-9]$/.test(input)) {
        const idx = Number.parseInt(input, 10) - 1;
        const opt = options[idx];
        if (!opt || opt.disabled || opt.type === 'input') {
          return;
        }
        setFocusedIndex(idx);
        toggle(opt.value);
      }
    },
    {
      isActive: !isDisabled,
    },
  );

  return (
    <Box flexDirection="column">
      {options.map((option, index) => (
        <SelectOption
          key={`opt-${String(option.value)}`}
          isFocused={index === focusedIndex}
          isSelected={selected.includes(option.value)}
          disabled={option.disabled}
          indexLabel={hideIndexes ? undefined : `${index + 1}.`}
          inlineDescription={inlineDescription}
          description={option.description}
        >
          {option.label}
        </SelectOption>
      ))}
    </Box>
  );
}

//#endregion
