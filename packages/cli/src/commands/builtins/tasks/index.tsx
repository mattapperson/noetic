import type { ReactNode } from 'react';

import type { Command, LocalJsxCommandCall } from '../../types.js';
import { loadTaskTableData } from './store.js';
import { TasksModal } from './ui/tasks-modal.js';

const call: LocalJsxCommandCall = async (onDone, ctx, _args): Promise<ReactNode> => {
  try {
    const data = await loadTaskTableData(ctx.cwd);
    return (
      <TasksModal
        projectRoot={data.projectRoot}
        databasePath={data.databasePath}
        rows={data.rows}
        onClose={() => {
          onDone('Tasks closed.');
        }}
      />
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return (
      <TasksModal
        projectRoot={ctx.cwd}
        databasePath=""
        rows={[]}
        error={message}
        onClose={() => {
          onDone('Tasks closed.');
        }}
      />
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
