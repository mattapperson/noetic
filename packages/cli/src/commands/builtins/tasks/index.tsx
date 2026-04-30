import { createLocalFsAdapter } from '@noetic/core';
import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';

import type { Command, LocalJsxCommandCall } from '../../types.js';
import type { AgentCiActionResult } from './agent-ci-control.js';
import { cancelAgentCiRun, togglePauseAgentCiRun } from './agent-ci-control.js';
import type { TaskStoreContext } from './fs-store.js';
import type { TaskTableData, TaskTableRow } from './store.js';
import { loadTaskTableData } from './store.js';
import { TasksModal } from './ui/tasks-modal.js';

interface ContainerProps {
  cwd: string;
  initial: TaskTableData;
  onClose: () => void;
}

function TasksContainer({ cwd, initial, onClose }: ContainerProps): ReactNode {
  const [data, setData] = useState<TaskTableData>(initial);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const reload = useCallback(async () => {
    const fresh = await loadTaskTableData(cwd);
    setData(fresh);
  }, [
    cwd,
  ]);

  const runAction = useCallback(
    (row: TaskTableRow, action: 'cancel' | 'toggle'): void => {
      if (inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      // The control surface is FS-backed; build a context rooted on the
      // current task's projectRoot so writes land alongside `task.json`.
      const ctx: TaskStoreContext = {
        fs: createLocalFsAdapter(),
        projectRoot: data.projectRoot,
      };
      const op =
        action === 'cancel' ? cancelAgentCiRun(ctx, row.id) : togglePauseAgentCiRun(ctx, row.id);
      void op
        .then((result) => {
          setLastResult(formatActionResult(row, result));
        })
        .catch((err: unknown) => {
          const verb = action === 'cancel' ? 'cancel' : 'pause/resume';
          const message = err instanceof Error ? err.message : String(err);
          setLastResult(`${row.title}: ${verb} failed (${message})`);
        })
        .finally(() => {
          void reload().finally(() => {
            inFlightRef.current = false;
          });
        });
    },
    [
      data.projectRoot,
      reload,
    ],
  );

  return (
    <TasksModal
      projectRoot={data.projectRoot}
      databasePath={data.databasePath}
      rows={data.rows}
      lastResult={lastResult}
      onClose={onClose}
      onCancel={(row) => {
        runAction(row, 'cancel');
      }}
      onTogglePause={(row) => {
        runAction(row, 'toggle');
      }}
    />
  );
}

function formatActionResult(row: TaskTableRow, result: AgentCiActionResult): string {
  switch (result.kind) {
    case 'cancelled':
      return `Cancelled agent-ci on ${row.title} (pid=${result.pid})`;
    case 'paused':
      return `Paused agent-ci on ${row.title} (pid=${result.pid})`;
    case 'resumed':
      return `Resumed agent-ci on ${row.title} (pid=${result.pid})`;
    case 'no_active_run':
      return `${row.title}: no active agent-ci run`;
    case 'stale_process':
      return `${row.title}: agent-ci process pid=${result.pid} no longer running`;
  }
}

const call: LocalJsxCommandCall = async (onDone, ctx, _args): Promise<ReactNode> => {
  const close = (): void => {
    onDone('Tasks closed.');
  };
  try {
    const data = await loadTaskTableData(ctx.cwd);
    return <TasksContainer cwd={ctx.cwd} initial={data} onClose={close} />;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return (
      <TasksModal projectRoot={ctx.cwd} databasePath="" rows={[]} error={message} onClose={close} />
    );
  }
};

export const tasks: Command = {
  type: 'local-jsx',
  name: 'tasks',
  description: 'Show project worktree tasks and review sessions',
  load: async () => ({
    call,
  }),
};

export { mission } from './missions/commands/index.js';
