export interface TaskCommandRequest {
  command: string;
  args?: ReadonlyArray<string>;
  cwd: string;
  timeoutMs?: number;
}

export type TaskCommandResult =
  | {
      kind: 'completed';
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }
  | {
      kind: 'skipped';
      reason: string;
    };

export interface TaskCommandAdapter {
  run(request: TaskCommandRequest): Promise<TaskCommandResult>;
}

export function createUnsupportedTaskCommandAdapter(): TaskCommandAdapter {
  return {
    async run() {
      return {
        kind: 'skipped',
        reason: 'External task commands require a host command adapter.',
      };
    },
  };
}
