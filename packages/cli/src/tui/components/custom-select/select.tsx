/**
 * Single-select keyboard-driven option list.
 *
 * Ported from ~/Desktop/claude-code-main/src/components/CustomSelect/select.tsx.
 * Uses stock Ink 7 `useInput` instead of the reference's custom
 * `useKeybindings` overlay stack.
 *
 * Keyboard:
 *  - ↑/↓ or k/j — move focus (wraps)
 *  - Enter — select focused option (or submit input option's value)
 *  - Esc — cancel
 *  - Tab — toggle input mode on an input-type option
 *  - 1–9 — jump to the Nth option (selects text options directly; focuses input options)
 */

import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SelectOption } from './select-option.js';
import type { Option } from './types.js';

//#region Props

export interface SelectProps<T> {
  readonly options: ReadonlyArray<Option<T>>;
  readonly isDisabled?: boolean;
  readonly hideIndexes?: boolean;
  readonly inlineDescription?: boolean;
  readonly defaultValue?: T;
  readonly defaultFocusValue?: T;
  readonly focusValue?: T;
  readonly onChange?: (value: T) => void;
  readonly onCancel?: () => void;
  readonly onFocus?: (value: T) => void;
  /** When true, a focused input option enters typing mode. */
  readonly isInTextInput?: boolean;
  readonly onInputModeToggle?: (value: T) => void;
}

//#endregion

//#region Helpers

function sanitizeIndex(index: number, length: number): number {
  if (length === 0) {
    return 0;
  }
  const wrapped = ((index % length) + length) % length;
  return wrapped;
}

function findValueIndex<T>(options: ReadonlyArray<Option<T>>, value: T | undefined): number {
  if (value === undefined) {
    return -1;
  }
  return options.findIndex((opt) => opt.value === value);
}

//#endregion

//#region Component

export function Select<T>({
  options,
  isDisabled,
  hideIndexes,
  inlineDescription,
  defaultValue,
  defaultFocusValue,
  focusValue,
  onChange,
  onCancel,
  onFocus,
  isInTextInput,
  onInputModeToggle,
}: SelectProps<T>) {
  const initialIndex = useMemo(() => {
    const focusIndex = findValueIndex(options, focusValue ?? defaultFocusValue);
    if (focusIndex >= 0) {
      return focusIndex;
    }
    const defaultIndex = findValueIndex(options, defaultValue);
    return defaultIndex >= 0 ? defaultIndex : 0;
  }, [
    options,
    focusValue,
    defaultFocusValue,
    defaultValue,
  ]);

  const [focusedIndex, setFocusedIndex] = useState(initialIndex);
  const [selectedValue, setSelectedValue] = useState<T | undefined>(defaultValue);

  // External focus sync.
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

  // Clamp when options list shrinks.
  useEffect(() => {
    if (focusedIndex >= options.length && options.length > 0) {
      setFocusedIndex(options.length - 1);
    }
  }, [
    options.length,
    focusedIndex,
  ]);

  const focusedOption = options[focusedIndex];
  const focusedValue = focusedOption?.value;

  // Track the last value we fired `onFocus` with so we don't notify again on
  // every parent re-render (which would happen whenever the consumer passes
  // an inline arrow as `onFocus`, since each render produces a new reference
  // and the effect's deps include `onFocus`).
  const lastFiredFocusRef = useRef<T | undefined>(undefined);
  useEffect(() => {
    if (focusedValue === undefined) {
      return;
    }
    if (lastFiredFocusRef.current === focusedValue) {
      return;
    }
    lastFiredFocusRef.current = focusedValue;
    onFocus?.(focusedValue);
  }, [
    focusedValue,
    onFocus,
  ]);

  const isInputFocused = focusedOption?.type === 'input';
  const inInputMode = !!(isInTextInput && isInputFocused);

  const moveFocus = useCallback(
    (delta: number) => {
      if (options.length === 0) {
        return;
      }
      setFocusedIndex((idx) => {
        let next = sanitizeIndex(idx + delta, options.length);
        // Skip disabled options.
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

  const selectCurrent = useCallback(() => {
    const opt = options[focusedIndex];
    if (!opt || opt.disabled) {
      return;
    }
    setSelectedValue(opt.value);
    onChange?.(opt.value);
  }, [
    focusedIndex,
    options,
    onChange,
  ]);

  useInput(
    (input, key) => {
      if (inInputMode) {
        // Arrows still navigate even while typing; other keys pass through to
        // the TextInput component.
        if (key.downArrow) {
          moveFocus(1);
          return;
        }
        if (key.upArrow) {
          moveFocus(-1);
          return;
        }
        // Two-stage Escape: first Esc inside the input exits input mode and
        // returns control to the option list. A second Esc (now outside
        // input mode) cancels the dialog.
        if (key.escape) {
          if (onInputModeToggle && focusedValue !== undefined) {
            onInputModeToggle(focusedValue);
          } else {
            onCancel?.();
          }
          return;
        }
        return;
      }

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
      if (key.tab && onInputModeToggle && focusedValue !== undefined) {
        onInputModeToggle(focusedValue);
        return;
      }
      if (key.return) {
        selectCurrent();
        return;
      }
      // Number keys 1–9 jump directly.
      if (/^[1-9]$/.test(input)) {
        const idx = Number.parseInt(input, 10) - 1;
        const target = options[idx];
        if (!target || target.disabled) {
          return;
        }
        if (target.type === 'input') {
          setFocusedIndex(idx);
          return;
        }
        // Move the visual cursor too so the selection echoes the change.
        setFocusedIndex(idx);
        setSelectedValue(target.value);
        onChange?.(target.value);
      }
    },
    {
      isActive: !isDisabled,
    },
  );

  return (
    <Box flexDirection="column">
      {options.map((option, index) => {
        const isFocused = index === focusedIndex;
        const isSelected = selectedValue === option.value;
        const indexLabel = hideIndexes ? undefined : `${index + 1}.`;
        if (option.type === 'input') {
          return (
            <SelectOption
              key={`opt-${String(option.value)}`}
              isFocused={isFocused}
              isSelected={isSelected}
              disabled={option.disabled}
              indexLabel={indexLabel}
              inlineDescription={inlineDescription}
              description={option.description}
            >
              <InputOptionEditor
                focused={isFocused && inInputMode}
                initialValue={option.initialValue}
                placeholder={option.placeholder}
                onChange={option.onChange}
                onSubmit={(value) => {
                  if (value.length === 0 && !option.allowEmptySubmitToCancel) {
                    onCancel?.();
                    return;
                  }
                  setSelectedValue(option.value);
                  onChange?.(option.value);
                }}
                label={typeof option.label === 'string' ? option.label : ''}
              />
            </SelectOption>
          );
        }
        return (
          <SelectOption
            key={`opt-${String(option.value)}`}
            isFocused={isFocused}
            isSelected={isSelected}
            disabled={option.disabled}
            indexLabel={indexLabel}
            inlineDescription={inlineDescription}
            description={option.description}
          >
            {option.label}
          </SelectOption>
        );
      })}
    </Box>
  );
}

//#endregion

//#region Input option helper

interface InputOptionEditorProps {
  focused: boolean;
  initialValue?: string;
  placeholder?: string;
  label: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

function InputOptionEditor({
  focused,
  initialValue,
  placeholder,
  label,
  onChange,
  onSubmit,
}: InputOptionEditorProps) {
  const [value, setValue] = useState<string>(initialValue ?? '');
  if (!focused) {
    return (
      <Box>
        <Text>{label}</Text>
        {value ? <Text>: {value}</Text> : null}
      </Box>
    );
  }
  return (
    <Box>
      <Text>{label}: </Text>
      <TextInput
        value={value}
        placeholder={placeholder ?? ''}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        onSubmit={() => onSubmit(value)}
        focus={focused}
      />
    </Box>
  );
}

//#endregion
