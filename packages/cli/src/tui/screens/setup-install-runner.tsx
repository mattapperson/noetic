/**
 * Live view of an auto-install command.
 *
 * Streams stdout/stderr into a scrollback tail and, when the process exits,
 * re-probes the binary detector. Success requires both `exitCode === 0` AND
 * `detect()` newly returning true — plenty of installers exit 0 after a
 * no-op.
 */

import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';

import { runInstallCommand } from '../../setup/install-runner.js';
import type { BinaryDescriptor, InstallOption } from '../../setup/types.js';

//#region Props

export interface SetupInstallRunnerProps {
  readonly descriptor: BinaryDescriptor;
  readonly option: InstallOption;
  readonly onInstalled: () => void;
  readonly onRetry: () => void;
}

//#endregion

//#region State

type Phase =
  | { kind: 'running'; lines: ReadonlyArray<string> }
  | { kind: 'verifying'; lines: ReadonlyArray<string> }
  | { kind: 'failed'; lines: ReadonlyArray<string>; reason: string };

const TAIL_SIZE = 20;

//#endregion

//#region Component

export function SetupInstallRunner({
  descriptor,
  option,
  onInstalled,
  onRetry,
}: SetupInstallRunnerProps) {
  const [phase, setPhase] = useState<Phase>({
    kind: 'running',
    lines: [],
  });
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const handle = runInstallCommand(option);
    cancelRef.current = handle.cancel;
    let cancelled = false;

    (async () => {
      const tail: string[] = [];
      let exitCode: number | null = null;
      for await (const event of handle.events) {
        if (cancelled) {
          return;
        }
        if (event.kind === 'line') {
          tail.push(event.text);
          while (tail.length > TAIL_SIZE) {
            tail.shift();
          }
          setPhase({
            kind: 'running',
            lines: [
              ...tail,
            ],
          });
          continue;
        }
        exitCode = event.exitCode;
      }

      if (cancelled) {
        return;
      }

      setPhase({
        kind: 'verifying',
        lines: [
          ...tail,
        ],
      });

      if (exitCode !== 0) {
        setPhase({
          kind: 'failed',
          lines: [
            ...tail,
          ],
          reason: `Install exited with code ${exitCode ?? 'unknown'}.`,
        });
        return;
      }

      const present = await descriptor.detect();
      if (!present) {
        setPhase({
          kind: 'failed',
          lines: [
            ...tail,
          ],
          reason: 'Command succeeded but the binary is still not detected.',
        });
        return;
      }

      onInstalled();
    })();

    return () => {
      cancelled = true;
      cancelRef.current?.();
    };
  }, [
    descriptor,
    option,
    onInstalled,
  ]);

  const handleRetry = useCallback(() => {
    cancelRef.current?.();
    onRetry();
  }, [
    onRetry,
  ]);

  useInput((input) => {
    if (phase.kind !== 'failed') {
      return;
    }
    if (input === 'r') {
      handleRetry();
    }
    if (input === 'm') {
      onRetry();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>
        Installing {descriptor.displayName} — {option.label}
      </Text>
      <Text dimColor>
        $ {option.command} {option.args.join(' ')}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {phase.lines.map((line, idx) => (
          <Text key={`${idx}-${line.slice(0, 16)}`} dimColor>
            {line}
          </Text>
        ))}
      </Box>
      {phase.kind === 'running' ? (
        <Box marginTop={1}>
          <Text color="cyan">… running</Text>
        </Box>
      ) : null}
      {phase.kind === 'verifying' ? (
        <Box marginTop={1}>
          <Text color="cyan">… verifying</Text>
        </Box>
      ) : null}
      {phase.kind === 'failed' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">{phase.reason}</Text>
          <Text dimColor>r retry · m back to menu</Text>
        </Box>
      ) : null}
    </Box>
  );
}

//#endregion
