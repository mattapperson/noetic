export interface TaskWorktreeRequest {
  taskId: string;
  branch: string;
  cwd: string;
}

export type TaskWorktreeResult =
  | {
      kind: 'ok';
      path: string;
      branch: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: 'unsupported';
      message: string;
    };

export interface TaskWorktreeAdapter {
  provision(request: TaskWorktreeRequest): Promise<TaskWorktreeResult>;
}

export function createUnsupportedTaskWorktreeAdapter(): TaskWorktreeAdapter {
  return {
    async provision() {
      return {
        kind: 'unsupported',
        message: 'Task worktree provisioning requires a host worktree adapter.',
      };
    },
  };
}
