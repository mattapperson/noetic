/**
 * Resume screen — lists sessions, hands off the selected `SessionFile` via
 * the provided `onSelect`/`onCancel` callbacks. Adapted from Claude Code's
 * `ResumeConversation` (src/screens/ResumeConversation.tsx).
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import {
  listAllSessions,
  listSessionsForCwd,
  loadSession,
  loadSessionByIdAnywhere,
} from '../../../sessions/store.js';
import type { SessionFile, SessionMetadata } from '../../../types/session.js';
import { useTheme } from '../theme.js';
import { shouldCancelOnKey } from './cancel-key.js';
import { LogSelector } from './log-selector.js';

export { shouldCancelOnKey } from './cancel-key.js';

//#region Types

export interface ResumeScreenProps {
  cwd: string;
  onSelect: (session: SessionFile) => void;
  onCancel: () => void;
}

type LoadState =
  | {
      kind: 'loading';
    }
  | {
      kind: 'error';
      message: string;
    }
  | {
      kind: 'ready';
      sameProject: ReadonlyArray<SessionMetadata>;
      allProjects: ReadonlyArray<SessionMetadata>;
    };

//#endregion

//#region Loader

async function loadAllMetas(cwd: string): Promise<{
  sameProject: ReadonlyArray<SessionMetadata>;
  allProjects: ReadonlyArray<SessionMetadata>;
}> {
  const [sameProject, allProjects] = await Promise.all([
    listSessionsForCwd(cwd),
    listAllSessions(),
  ]);
  return {
    sameProject,
    allProjects,
  };
}

async function loadFileFor(meta: SessionMetadata): Promise<SessionFile | null> {
  const direct = await loadSession(meta.cwd, meta.sessionId);
  if (direct !== null) {
    return direct;
  }
  return loadSessionByIdAnywhere(meta.sessionId);
}

//#endregion

//#region Component

function LoadingView(): ReactNode {
  const theme = useTheme();
  return (
    <Box padding={1}>
      <Text color={theme.muted}>Loading sessions…</Text>
    </Box>
  );
}

function ErrorView({ message }: { message: string }): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column" padding={1}>
      <Text color={theme.error}>Failed to load sessions: {message}</Text>
      <Text dimColor>Press Esc to exit.</Text>
    </Box>
  );
}

/** Local useInput so Esc/Ctrl+C actually exit this view when LogSelector is unmounted. */
function LoadFailedView({
  sessionId,
  onCancel,
}: {
  sessionId: string;
  onCancel: () => void;
}): ReactNode {
  const theme = useTheme();
  useInput((input, key) => {
    if (shouldCancelOnKey(input, key)) {
      onCancel();
    }
  });
  return (
    <Box flexDirection="column" padding={1}>
      <Text color={theme.error}>Failed to load session: {sessionId}</Text>
      <Text dimColor>Press Esc to exit.</Text>
    </Box>
  );
}

export function ResumeScreen({ cwd, onSelect, onCancel }: ResumeScreenProps): ReactNode {
  const [state, setState] = useState<LoadState>({
    kind: 'loading',
  });
  const [loadFailed, setLoadFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const { sameProject, allProjects } = await loadAllMetas(cwd);
        if (cancelled) {
          return;
        }
        setState({
          kind: 'ready',
          sameProject,
          allProjects,
        });
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({
          kind: 'error',
          message,
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    cwd,
  ]);

  if (state.kind === 'loading') {
    return <LoadingView />;
  }
  if (state.kind === 'error') {
    return <ErrorView message={state.message} />;
  }

  if (loadFailed !== null) {
    return <LoadFailedView sessionId={loadFailed} onCancel={onCancel} />;
  }

  return (
    <LogSelector
      sameProjectSessions={state.sameProject}
      allProjectsSessions={state.allProjects}
      onCancel={onCancel}
      onSelect={(meta) => {
        void loadFileFor(meta).then((file) => {
          if (file === null) {
            setLoadFailed(meta.sessionId);
            return;
          }
          onSelect(file);
        });
      }}
    />
  );
}

//#endregion
