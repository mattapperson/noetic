/**
 * Tool wrapper around {@link spawnValidatorChild}. Created so the validator
 * flow (Wave 3) can drive the external-subprocess fallback via
 * `step.tool({ id, tool: validatorLauncherTool })` instead of calling the
 * imperative spawn helper directly.
 *
 * The tool expects an already-recorded validator run row (the upstream flow
 * step creates the row, this tool just spawns the child and patches pid
 * metadata onto the row). For test isolation, prefer
 * {@link createValidatorLauncherTool} which exposes pluggable `spawnFn` /
 * `signaller` seams; the default {@link validatorLauncherTool} export uses
 * the real `node:child_process` spawn and the OS signaller.
 */

import {
  FeatureIdSchema,
  TaskIdSchema,
  ValidatorRunIdSchema,
} from '@noetic/code-agent/tasks/schema';
import type { Tool } from '@noetic-tools/core';
import { tool } from '@noetic-tools/core';
import { z } from 'zod';
import type { Signaller } from '../agent-ci-control.js';
import type { ValidatorContext } from './validator.js';
import type { ValidatorSpawn } from './validator-launcher.js';
import { spawnValidatorChild } from './validator-launcher.js';

//#region Types

/** Optional seams for {@link createValidatorLauncherTool}. */
export interface ValidatorLauncherToolOptions {
  readonly spawnFn?: ValidatorSpawn;
  readonly signaller?: Signaller;
}

//#endregion

//#region Schemas

const ValidatorLauncherInputSchema = z.object({
  taskId: TaskIdSchema,
  featureId: FeatureIdSchema,
  runId: ValidatorRunIdSchema,
  /** External command to invoke. */
  command: z.string().min(1),
  /** Command arguments. */
  args: z.array(z.string()),
  /** Working directory for the child (defaults to `projectRoot`). */
  cwd: z.string().optional(),
  /** Project root that the spawn cwd defaults to. */
  projectRoot: z.string().min(1),
  /**
   * Override for the tasks-root directory. Rarely passed — production
   * callers use the `NOETIC_HOME`-resolved default. Tests pin this to
   * a MemFs-friendly path.
   */
  tasksRoot: z.string().optional(),
});

const ValidatorLauncherOutputSchema = z.object({
  pid: z.number().int(),
  pidStarttime: z.string().nullable(),
});

type ValidatorLauncherInput = z.infer<typeof ValidatorLauncherInputSchema>;
type ValidatorLauncherOutput = z.infer<typeof ValidatorLauncherOutputSchema>;

//#endregion

//#region Public API

/**
 * Build a `validatorLauncherTool` with optional pluggable spawn / signaller
 * seams. Tests pass mocks; production callers use the no-arg
 * {@link validatorLauncherTool} export below.
 */
export function createValidatorLauncherTool(
  opts: ValidatorLauncherToolOptions = {},
): Tool<typeof ValidatorLauncherInputSchema, typeof ValidatorLauncherOutputSchema> {
  return tool({
    name: 'tasks.validator-launcher',
    description: 'Spawn the external validator subprocess for a feature.',
    input: ValidatorLauncherInputSchema,
    output: ValidatorLauncherOutputSchema,
    execute: async (args: ValidatorLauncherInput, toolCtx): Promise<ValidatorLauncherOutput> => {
      const validatorCtx: ValidatorContext = {
        fs: toolCtx.fs,
        projectRoot: args.projectRoot,
        tasksRoot: args.tasksRoot,
        taskId: args.taskId,
      };
      const result = await spawnValidatorChild({
        ctx: validatorCtx,
        featureId: args.featureId,
        runId: args.runId,
        command: args.command,
        args: args.args,
        cwd: args.cwd,
        spawnFn: opts.spawnFn,
        signaller: opts.signaller,
      });
      return {
        pid: result.pid,
        pidStarttime: result.pidStarttime,
      };
    },
  });
}

/** Default validator-launcher tool: real spawn, real signaller. */
export const validatorLauncherTool = createValidatorLauncherTool();

//#endregion
