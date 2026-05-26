/**
 * Wait-for-manual-install screen.
 *
 * Shows OS-appropriate install instructions, polls the detector every second,
 * and auto-advances on first success. Users can press `i` to persist an
 * ignore or `b` to go back to the menu.
 */

import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import type { BinaryDescriptor, OsKind } from '../../setup/types.js';

//#region Props

export interface SetupManualWaiterProps {
  readonly descriptor: BinaryDescriptor;
  readonly os: OsKind;
  readonly onInstalled: () => void;
  readonly onIgnore: () => void;
  readonly onBack: () => void;
}

//#endregion

//#region Component

const POLL_MS = 1_000;

export function SetupManualWaiter({
  descriptor,
  os,
  onInstalled,
  onIgnore,
  onBack,
}: SetupManualWaiterProps) {
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) {
        return;
      }
      setAttempts((n) => n + 1);
      const present = await descriptor.detect();
      if (stopped) {
        return;
      }
      if (present) {
        onInstalled();
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };

    timer = setTimeout(tick, POLL_MS);

    return () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [
    descriptor,
    onInstalled,
  ]);

  useInput((input) => {
    if (input === 'i') {
      onIgnore();
      return;
    }
    if (input === 'b') {
      onBack();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Install {descriptor.displayName} manually</Text>
      <Box flexDirection="column" marginTop={1}>
        {descriptor
          .manualInstructionsFor(os)
          .split('\n')
          .map((line) => (
            <Text key={line}>{line}</Text>
          ))}
      </Box>
      <Box marginTop={1}>
        <Text color="cyan">
          … polling every {POLL_MS / 1_000}s (checked {attempts} times)
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>i ignore · b back</Text>
      </Box>
    </Box>
  );
}

//#endregion
