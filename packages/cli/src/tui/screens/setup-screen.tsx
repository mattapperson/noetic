/**
 * Top-level interactive setup screen.
 *
 * Walks the user through each missing binary in order. For each binary, the
 * user picks one of three paths:
 *   - auto-install (runs a detected install command live and re-probes)
 *   - manual install (shows OS-specific instructions and polls)
 *   - ignore (persisted to `~/.config/noetic/config.ts`)
 *
 * When every binary has been resolved (installed or ignored), the screen
 * fires `onComplete` with a `BinaryAvailability` map the harness consumes.
 */

import { Box, Text } from 'ink';
import { useCallback, useMemo, useState } from 'react';

import { BINARY_MANIFEST } from '../../setup/binary-manifest.js';
import type {
  BinaryAvailability,
  BinaryDescriptor,
  BinaryId,
  InstallOption,
  OsKind,
  PackageManager,
} from '../../setup/types.js';
import { appendIgnoredBinary } from '../../setup/user-config-writer.js';
import { Select } from '../components/custom-select/index.js';
import type { Option } from '../components/custom-select/index.js';
import { SetupInstallRunner } from './setup-install-runner.js';
import { SetupManualWaiter } from './setup-manual-waiter.js';

//#region Props

export interface SetupScreenProps {
  /** The binaries the resolver flagged as missing-and-not-ignored. */
  readonly missing: ReadonlyArray<BinaryId>;
  /**
   * Pre-resolved platform info. The runner passes this in so unit tests can
   * supply synthetic values without hitting the real PATH.
   */
  readonly os: OsKind;
  readonly packageManagers: ReadonlyArray<PackageManager>;
  /**
   * Called once every binary has been resolved. The map has one entry per
   * binary in the full manifest — present binaries that were already OK
   * before the flow started must be merged in by the coordinator.
   */
  readonly onComplete: (resolved: BinaryAvailability) => void;
  /** Dependency-injection seams for tests. */
  readonly onPersistIgnore?: (id: BinaryId) => Promise<void>;
}

//#endregion

//#region Per-binary state

type BinaryScreenState =
  | { kind: 'menu' }
  | { kind: 'auto'; option: InstallOption }
  | { kind: 'manual' }
  | { kind: 'done'; outcome: 'present' | 'ignored' };

//#endregion

//#region Main component

export function SetupScreen({
  missing,
  os,
  packageManagers,
  onComplete,
  onPersistIgnore,
}: SetupScreenProps) {
  const [cursor, setCursor] = useState(0);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<BinaryId, 'present' | 'ignored'>>(
    new Map(),
  );

  const current = missing[cursor];
  const descriptor = useMemo(() => {
    if (!current) {
      return undefined;
    }
    return BINARY_MANIFEST.find((d) => d.id === current);
  }, [
    current,
  ]);

  const advance = useCallback(
    (id: BinaryId, outcome: 'present' | 'ignored') => {
      setOutcomes((prev) => {
        const next = new Map(prev);
        next.set(id, outcome);
        return next;
      });
      const nextCursor = cursor + 1;
      if (nextCursor >= missing.length) {
        const final = new Map(outcomes);
        final.set(id, outcome);
        onComplete(final);
        return;
      }
      setCursor(nextCursor);
    },
    [
      cursor,
      missing.length,
      onComplete,
      outcomes,
    ],
  );

  if (!current || !descriptor) {
    return null;
  }

  return (
    <BinaryPrompt
      descriptor={descriptor}
      os={os}
      packageManagers={packageManagers}
      onResolved={(outcome) => advance(current, outcome)}
      onPersistIgnore={onPersistIgnore}
      step={cursor + 1}
      total={missing.length}
    />
  );
}

//#endregion

//#region Single-binary prompt

interface BinaryPromptProps {
  readonly descriptor: BinaryDescriptor;
  readonly os: OsKind;
  readonly packageManagers: ReadonlyArray<PackageManager>;
  readonly onResolved: (outcome: 'present' | 'ignored') => void;
  readonly onPersistIgnore?: (id: BinaryId) => Promise<void>;
  readonly step: number;
  readonly total: number;
}

function BinaryPrompt({
  descriptor,
  os,
  packageManagers,
  onResolved,
  onPersistIgnore,
  step,
  total,
}: BinaryPromptProps) {
  const [state, setState] = useState<BinaryScreenState>({
    kind: 'menu',
  });
  const [error, setError] = useState<string | null>(null);

  const installOptions = useMemo(
    () => descriptor.installOptionsFor(os, packageManagers),
    [
      descriptor,
      os,
      packageManagers,
    ],
  );

  const menuOptions = useMemo(() => {
    const opts: Option<string>[] = [];
    installOptions.forEach((option, idx) => {
      opts.push({
        value: `auto:${idx}`,
        label: `Install with ${option.label}`,
        description: `Runs \`${option.command} ${option.args.join(' ')}\``,
      });
    });
    opts.push({
      value: 'manual',
      label: 'I will install it manually',
      description: 'Show instructions and wait for the binary to appear.',
    });
    opts.push({
      value: 'ignore',
      label: 'Ignore (never ask again on this machine)',
      description: `Persists to ~/.config/noetic/setup.json. ${describeIgnoreImpact(descriptor)}`,
    });
    return opts;
  }, [
    descriptor,
    installOptions,
  ]);

  const handleIgnore = useCallback(async () => {
    const persist = onPersistIgnore ?? (async (id: BinaryId) => {
      await appendIgnoredBinary(id);
    });
    try {
      await persist(descriptor.id);
    } catch (err) {
      setError(
        `Could not write ~/.config/noetic/setup.json (${err instanceof Error ? err.message : String(err)}). Ignored for this session only.`,
      );
    }
    setState({
      kind: 'done',
      outcome: 'ignored',
    });
    onResolved('ignored');
  }, [
    descriptor.id,
    onPersistIgnore,
    onResolved,
  ]);

  const handleSelect = useCallback(
    (value: string) => {
      if (value === 'manual') {
        setState({
          kind: 'manual',
        });
        return;
      }
      if (value === 'ignore') {
        void handleIgnore();
        return;
      }
      if (value.startsWith('auto:')) {
        const idx = Number.parseInt(value.slice(5), 10);
        const option = installOptions[idx];
        if (!option) {
          return;
        }
        setState({
          kind: 'auto',
          option,
        });
      }
    },
    [
      handleIgnore,
      installOptions,
    ],
  );

  if (state.kind === 'auto') {
    return (
      <SetupInstallRunner
        descriptor={descriptor}
        option={state.option}
        onInstalled={() => onResolved('present')}
        onRetry={() =>
          setState({
            kind: 'menu',
          })
        }
      />
    );
  }

  if (state.kind === 'manual') {
    return (
      <SetupManualWaiter
        descriptor={descriptor}
        os={os}
        onInstalled={() => onResolved('present')}
        onIgnore={() => void handleIgnore()}
        onBack={() =>
          setState({
            kind: 'menu',
          })
        }
      />
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>
        Noetic setup ({step}/{total}): {descriptor.displayName}
      </Text>
      <Box marginTop={1}>
        <Text>{descriptor.summary}</Text>
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color="yellow">{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Select options={menuOptions} onChange={handleSelect} />
      </Box>
    </Box>
  );
}

export function describeIgnoreImpact(descriptor: BinaryDescriptor): string {
  const omits = descriptor.affects.filter((a) => a.mode === 'omit').map((a) => a.toolId);
  const degrades = descriptor.affects.filter((a) => a.mode === 'degrade').map((a) => a.toolId);
  const parts: string[] = [];
  if (omits.length > 0) {
    parts.push(`the ${omits.join(', ')} tool${omits.length === 1 ? '' : 's'} will not be registered`);
  }
  if (degrades.length > 0) {
    parts.push(
      `the ${degrades.join(', ')} tool${degrades.length === 1 ? '' : 's'} will run in a degraded mode`,
    );
  }
  if (parts.length === 0) {
    return '';
  }
  return `Impact: ${parts.join('; ')}.`;
}

//#endregion
