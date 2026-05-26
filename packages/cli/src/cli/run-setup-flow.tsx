/**
 * Coordinator for the interactive startup binary-check flow.
 *
 * Called by `cli.ts` between config discovery and harness creation. If every
 * binary is already present or ignored, returns immediately. Otherwise renders
 * the Ink `SetupScreen`, waits for the user to resolve each missing binary,
 * persists any ignores to `~/.config/noetic/config.ts`, and resolves with a
 * `BinaryAvailability` map.
 *
 * Non-TTY (pipes, CI, daemon spawns) short-circuits: we write a one-line
 * stderr notice per missing binary and treat everything as `ignored` for the
 * run, so scripts never deadlock on a hidden prompt.
 */

import { render } from 'ink';

import { BINARY_MANIFEST } from '../setup/binary-manifest.js';
import { detectOs, detectPackageManagers } from '../setup/platform.js';
import { resolveBinaryStatuses } from '../setup/resolver.js';
import type { BinaryAvailability, BinaryId, BinaryStatus } from '../setup/types.js';
import { InkProvider } from '../tui/components/index.js';
import { SetupScreen } from '../tui/screens/setup-screen.js';
import type { AgentConfig } from '../types/config.js';

//#region Types

export interface RunSetupFlowOptions {
  readonly config: AgentConfig;
  /** Default: `process.stdin.isTTY`. Tests inject a fixed boolean. */
  readonly isInteractive?: boolean;
  /** Default: `process.stderr.write`. Tests inject a capture function. */
  readonly writeNotice?: (line: string) => void;
}

//#endregion

//#region Public API

export async function runSetupFlow(options: RunSetupFlowOptions): Promise<BinaryAvailability> {
  const statuses = await resolveBinaryStatuses(options.config, BINARY_MANIFEST);
  const missing = statuses.filter((s) => s.state === 'missing');
  const initial = statusesToAvailability(statuses);

  if (missing.length === 0) {
    return initial;
  }

  const isInteractive = options.isInteractive ?? process.stdin.isTTY === true;
  if (!isInteractive) {
    emitNonTtyNotices(missing, options.writeNotice);
    return withDefaults(initial, missing, 'ignored');
  }

  const os = detectOs();
  const packageManagers = await detectPackageManagers(os);

  const resolved = await renderSetupScreen({
    missing: missing.map((m) => m.id),
    os,
    packageManagers,
  });

  return mergeAvailability(initial, resolved);
}

//#endregion

//#region Helpers

function statusesToAvailability(
  statuses: ReadonlyArray<BinaryStatus>,
): Map<BinaryId, 'present' | 'ignored'> {
  const map = new Map<BinaryId, 'present' | 'ignored'>();
  for (const status of statuses) {
    if (status.state === 'present') {
      map.set(status.id, 'present');
    } else if (status.state === 'ignored') {
      map.set(status.id, 'ignored');
    }
  }
  return map;
}

function withDefaults(
  base: Map<BinaryId, 'present' | 'ignored'>,
  missing: ReadonlyArray<BinaryStatus>,
  fallback: 'present' | 'ignored',
): BinaryAvailability {
  for (const m of missing) {
    base.set(m.id, fallback);
  }
  return base;
}

function mergeAvailability(
  base: Map<BinaryId, 'present' | 'ignored'>,
  overlay: ReadonlyMap<BinaryId, 'present' | 'ignored'>,
): BinaryAvailability {
  for (const [k, v] of overlay) {
    base.set(k, v);
  }
  return base;
}

function emitNonTtyNotices(
  missing: ReadonlyArray<BinaryStatus>,
  writeNotice: ((line: string) => void) | undefined,
): void {
  const emit = writeNotice ?? ((line: string) => process.stderr.write(line));
  for (const m of missing) {
    emit(
      `[noetic] ${m.id} is missing — run the CLI interactively to install it, or add "${m.id}" to setup.ignoredBinaries in ~/.config/noetic/config.ts to silence this.\n`,
    );
  }
}

async function renderSetupScreen(params: {
  missing: ReadonlyArray<BinaryId>;
  os: ReturnType<typeof detectOs>;
  packageManagers: Awaited<ReturnType<typeof detectPackageManagers>>;
}): Promise<ReadonlyMap<BinaryId, 'present' | 'ignored'>> {
  return new Promise((resolve) => {
    const instance = render(
      <InkProvider>
        <SetupScreen
          missing={params.missing}
          os={params.os}
          packageManagers={params.packageManagers}
          onComplete={(result) => {
            instance.unmount();
            resolve(result);
          }}
        />
      </InkProvider>,
    );
  });
}

//#endregion
