import type { TurnContext } from '@openrouter/sdk';
import type { StepMeta } from './common';
import type { Context } from './context';
import type { Item } from './items';
import type { Runtime } from './runtime';

export interface ToolMemory {
  get<T>(layerId: string): T | undefined;
  set<T>(layerId: string, state: T): void;
}

export interface ToolExecutionContext {
  readonly ctx: Context;
  readonly runtime: Runtime;
  readonly memory: ToolMemory;
  readonly assembledView: ReadonlyArray<Item>;
  readonly lastStepMeta: StepMeta | null;
  readonly turnContext?: TurnContext;
}
