import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';

import type { Command, LocalJsxCommandCall } from '../../types.js';
import type { AgentCiActionResult } from './agent-ci-control.js';
import { cancelAgentCiRun, togglePauseAgentCiRun } from './agent-ci-control.js';
import { openTasksDatabase } from './db/index.js';
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
      const opened = openTasksDatabase(cwd);
      try {
        const result =
          action === 'cancel'
            ? cancelAgentCiRun(opened.db, row.id)
            : togglePauseAgentCiRun(opened.db, row.id);
        setLastResult(formatActionResult(row, result));
      } catch (err) {
        const verb = action === 'cancel' ? 'cancel' : 'pause/resume';
        const message = err instanceof Error ? err.message : String(err);
        setLastResult(`${row.title}: ${verb} failed (${message})`);
      } finally {
        opened.close();
      }
      void reload().finally(() => {
        inFlightRef.current = false;
      });
    },
    [
      cwd,
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
    case 'pid_unavailable':
      return `${row.title}: agent-ci run has no tracked PID`;
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
