import type { Tool } from '@noetic-tools/core';
import { tool } from '@noetic-tools/core/portable';
import { z } from 'zod';
import {
  AutopilotState,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSchema,
  TaskSource,
} from './schemas.js';
import type { TaskStoreAdapter } from './store-memory.js';
import { createMemoryTaskStore } from './store-memory.js';

interface TaskToolsPluginContext {
  readonly cwd: string;
}

interface TaskToolsPlugin {
  readonly name: string;
  readonly version: string;
  tools(ctx: TaskToolsPluginContext): Tool[];
}

export interface TaskToolsPluginOptions {
  store?: TaskStoreAdapter;
}

const TaskCreateInputSchema = z.object({
  title: z.string().min(1),
  projectRoot: z.string().optional(),
  source: z
    .enum([
      TaskSource.Manual,
      TaskSource.Worktree,
    ])
    .optional(),
});

const TaskListOutputSchema = z.object({
  tasks: z.array(TaskSchema),
});

const TaskUpdateInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  reviewStatus: z
    .enum([
      TaskReviewStatus.NotStarted,
      TaskReviewStatus.Reviewing,
      TaskReviewStatus.NeedsChanges,
      TaskReviewStatus.Approved,
    ])
    .optional(),
  lifecycleStatus: z
    .enum([
      TaskLifecycleStatus.Active,
      TaskLifecycleStatus.Merged,
      TaskLifecycleStatus.CleanupBlocked,
      TaskLifecycleStatus.Removed,
    ])
    .optional(),
  autopilotState: z
    .enum([
      AutopilotState.Inactive,
      AutopilotState.Planning,
      AutopilotState.Watching,
      AutopilotState.Activating,
      AutopilotState.Completing,
    ])
    .optional(),
  paused: z.boolean().optional(),
});

function taskTools(store: TaskStoreAdapter, cwd: string): Tool[] {
  return [
    tool({
      name: 'TaskCreate',
      description: 'Create a task in the configured task store.',
      input: TaskCreateInputSchema,
      output: TaskSchema,
      execute(args) {
        return store.createTask({
          title: args.title,
          projectRoot: args.projectRoot ?? cwd,
          source: args.source,
        });
      },
    }),
    tool({
      name: 'TaskList',
      description: 'List tasks from the configured task store.',
      input: z.object({}),
      output: TaskListOutputSchema,
      async execute() {
        return {
          tasks: [
            ...(await store.listTasks()),
          ],
        };
      },
    }),
    tool({
      name: 'TaskUpdate',
      description: 'Update a task in the configured task store.',
      input: TaskUpdateInputSchema,
      output: TaskSchema,
      execute(args) {
        const { id, ...patch } = args;
        return store.updateTask({
          taskId: id,
          patch,
        });
      },
    }),
  ];
}

export function createTaskToolsPlugin(options: TaskToolsPluginOptions = {}): TaskToolsPlugin {
  const store = options.store ?? createMemoryTaskStore();
  return {
    name: 'noetic:tasks',
    version: '0.1.0',
    tools(ctx) {
      return taskTools(store, ctx.cwd);
    },
  };
}
