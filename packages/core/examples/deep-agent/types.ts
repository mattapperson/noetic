/**
 * Shared types for the deep agent example.
 *
 * Mirrors the key concepts from DeepAgentsJS (middleware, skills, instructions)
 * mapped onto Noetic's type system.
 */

//#region Todo Types

const TodoStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
  Blocked: 'blocked',
} as const;

type TodoStatus = (typeof TodoStatus)[keyof typeof TodoStatus];

interface TodoItem {
  id: string;
  description: string;
  status: TodoStatus;
}

interface TodoState {
  items: TodoItem[];
}

//#endregion

//#region Skills Types

interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
}

interface SkillsLayerState {
  definitions: SkillDefinition[];
  activatedSkills: string[];
}

//#endregion

//#region Deep Agent Config

interface DeepAgentConfig {
  model: string;
  system: string;
  rootDir: string;
  skills?: SkillDefinition[];
  instructionFiles?: string[];
  maxSteps?: number;
  maxCost?: number;
  subAgentResolver?: SubAgentResolver;
}

//#endregion

export type { SubAgentConfig, SubAgentResolver } from '../delegate-tools';

export type { DeepAgentConfig, SkillDefinition, SkillsLayerState, TodoItem, TodoState };
export { TodoStatus };
