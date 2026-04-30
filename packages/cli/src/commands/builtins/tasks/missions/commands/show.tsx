/**
 * `/mission show <id>` — Ink container that loads a mission hierarchy and renders
 * MissionShowModal. Subscribes to `missionEvents` for hot reload.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureDaemon } from '../../../../../daemon-runtime/runtime.js';
import { useTheme } from '../../../../../tui/components/theme.js';
import { getTasksDatabasePath } from '../../db/index.js';
import type { MissionHierarchy } from '../store.js';
import { getMissionWithHierarchy, MissionEventName, missionEvents } from '../store.js';
import type { TriageTarget } from '../ui/mission-show-modal.js';
import { MissionShowModal } from '../ui/mission-show-modal.js';
import { runMissionActivateSlice } from './activate-slice.js';

export interface MissionShowContainerProps {
  cwd: string;
  missionId: string;
  initial: MissionHierarchy;
  onClose: () => void;
  ensureDaemonFn?: (cwd: string) => void;
}

export function MissionShowContainer(props: MissionShowContainerProps): ReactNode {
  const { cwd, missionId, initial, onClose } = props;
  const [hierarchy, setHierarchy] = useState<MissionHierarchy>(initial);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const ensureDaemonFn = props.ensureDaemonFn ?? ensureDaemon;
  const databasePath = getTasksDatabasePath(cwd);

  const reload = useCallback((): void => {
    const fresh = getMissionWithHierarchy(cwd, missionId);
    if (fresh !== null) {
      setHierarchy(fresh);
    }
  }, [
    cwd,
    missionId,
  ]);

  useEffect(() => {
    const onEvent = (): void => {
      reload();
    };
    const events = [
      MissionEventName.MissionStatusChanged,
      MissionEventName.FeatureLoopStateChanged,
      MissionEventName.FeatureLinkedToTask,
      MissionEventName.FeatureFixGenerated,
      MissionEventName.FeatureBudgetExhausted,
      MissionEventName.ValidatorRunRecorded,
    ] as const;
    for (const event of events) {
      missionEvents.on(event, onEvent);
    }
    return () => {
      for (const event of events) {
        missionEvents.off(event, onEvent);
      }
    };
  }, [
    reload,
  ]);

  const onActivateSlice = useCallback(
    async (slice: { id: string; title: string }): Promise<void> => {
      if (inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      try {
        const message = await runMissionActivateSlice(cwd, slice.id, {
          ensureDaemonFn,
        });
        setLastResult(message);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLastResult(`activate-slice failed: ${message}`);
      } finally {
        inFlightRef.current = false;
      }
      reload();
    },
    [
      cwd,
      ensureDaemonFn,
      reload,
    ],
  );

  const onTriage = useCallback((target: TriageTarget): void => {
    if (target.kind === 'slice') {
      setLastResult(
        `Triage on slice ${target.slice.id} not yet wired in this build. (Use /mission activate-slice with autopilot enabled.)`,
      );
      return;
    }
    setLastResult(
      `Triage on feature ${target.feature.id} not yet wired in this build. (Daemon will triage when slice is active.)`,
    );
  }, []);

  return (
    <MissionShowModal
      hierarchy={hierarchy}
      databasePath={databasePath}
      lastResult={lastResult}
      onClose={onClose}
      onActivateSlice={(slice) => {
        void onActivateSlice(slice);
      }}
      onTriage={onTriage}
    />
  );
}

export interface MissionShowErrorProps {
  message: string;
  onClose: () => void;
}

export function MissionShowError(props: MissionShowErrorProps): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.error} paddingX={1}>
      <Text color={theme.error}>Mission show failed</Text>
      <Text>{props.message}</Text>
      <Box marginTop={1}>
        <Text dimColor>Press q/Esc to close.</Text>
      </Box>
      <CloseHandler onClose={props.onClose} />
    </Box>
  );
}

function CloseHandler(props: { onClose: () => void }): ReactNode {
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      props.onClose();
    }
  });
  return null;
}
