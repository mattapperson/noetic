/**
 * Task planning tools — mirrors DeepAgentsJS todoListMiddleware.
 *
 * Tools declare state via ToolContextDeclaration; toolCalls() materializes it.
 * Tools read/write state via toolCtx.context.
 */

import type { Tool, ToolContextDeclaration } from '@noetic-tools/types';
import { z } from 'zod';
import { tool } from '../../../src/builders/tool-builder';
import type { TodoItem, TodoState } from '../types';
import { TodoStatus } from '../types';

const TODO_CONTEXT_ID = 'todos';

//#region Context Declaration

const STATUS_ICONS: Record<string, string> = {
  [TodoStatus.Pending]: '[ ]',
  [TodoStatus.InProgress]: '[~]',
  [TodoStatus.Completed]: '[x]',
  [TodoStatus.Blocked]: '[!]',
};

export const todoContext: ToolContextDeclaration<TodoState> = {
  id: TODO_CONTEXT_ID,
  init: () => ({
    items: [],
  }),
  recall: (state) => {
    if (!state.items.length) {
      return null;
    }
    const lines = state.items.map(
      (item) => `${STATUS_ICONS[item.status] ?? '[ ]'} ${item.id}: ${item.description}`,
    );
    return `<todos>\n${lines.join('\n')}\n</todos>`;
  },
};

//#endregion

//#region Helper Functions

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function getTodoState(toolCtx: {
  context: {
    get<T>(id: string): T | undefined;
  };
}): TodoState {
  return (
    toolCtx.context.get<TodoState>(TODO_CONTEXT_ID) ?? {
      items: [],
    }
  );
}

function setTodoState(
  toolCtx: {
    context: {
      set<T>(id: string, state: T): void;
    };
  },
  state: TodoState,
): void {
  toolCtx.context.set(TODO_CONTEXT_ID, state);
}

//#endregion

//#region Tool Definitions

const TodoItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum([
    'pending',
    'in_progress',
    'completed',
    'blocked',
  ]),
});

function createWriteTodosTool(): Tool {
  return tool({
    name: 'write_todos',
    description: 'Create new todo items for planning and tracking tasks.',
    input: z.object({
      items: z.array(z.string()).describe('List of task descriptions'),
    }),
    output: z.array(TodoItemSchema),
    execute: async (args, toolCtx): Promise<TodoItem[]> => {
      const state = getTodoState(toolCtx);
      const newItems: TodoItem[] = args.items.map((description: string) => ({
        id: generateId(),
        description,
        status: TodoStatus.Pending,
      }));
      const updatedState: TodoState = {
        items: [
          ...state.items,
          ...newItems,
        ],
      };
      setTodoState(toolCtx, updatedState);
      return newItems;
    },
    context: todoContext,
  });
}

function createUpdateTodoTool(): Tool {
  return tool({
    name: 'update_todo',
    description: 'Update the status of an existing todo item.',
    input: z.object({
      id: z.string().describe('The todo item ID'),
      status: z
        .enum([
          'pending',
          'in_progress',
          'completed',
          'blocked',
        ])
        .describe('New status'),
    }),
    output: TodoItemSchema,
    execute: async (args, toolCtx): Promise<TodoItem> => {
      const state = getTodoState(toolCtx);
      const item = state.items.find((i) => i.id === args.id);
      if (!item) {
        throw new Error(`Todo item not found: ${args.id}`);
      }
      item.status = args.status;
      setTodoState(toolCtx, state);
      return item;
    },
    context: todoContext,
  });
}

function createListTodosTool(): Tool {
  return tool({
    name: 'list_todos',
    description: 'List all current todo items and their statuses.',
    input: z.object({}),
    output: z.array(TodoItemSchema),
    execute: async (_args, toolCtx): Promise<TodoItem[]> => {
      const state = getTodoState(toolCtx);
      return state.items;
    },
    context: todoContext,
  });
}

//#endregion

//#region Public API

export function createTodoTools(): Tool[] {
  return [
    createWriteTodosTool(),
    createUpdateTodoTool(),
    createListTodosTool(),
  ];
}

//#endregion
