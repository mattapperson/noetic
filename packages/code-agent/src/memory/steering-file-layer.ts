/**
 * Steering-file memory layer — surfaces `<taskDir>/steering.md` to a task's
 * agent run.
 *
 * Activation is gated by the `NOETIC_TASK_DIR` environment variable, which
 * the task launcher sets when spawning agent-ci for a specific task. When the
 * variable is unset (every non-task agent run), `recall()` returns `null` and
 * the layer is effectively dormant. When set, the layer reads
 * `<NOETIC_TASK_DIR>/steering.md` via `ctx.fs.readFileText`. A missing
 * `steering.md` (ENOENT) is treated as "no steering content" and yields
 * `null` rather than an error so half-populated task directories degrade
 * gracefully.
 *
 * Slot lives at `Slot.STEERING` (90), placing the file ahead of working
 * memory and observations so steering nudges shape interpretation of every
 * downstream block.
 */

import type { MemoryLayer } from '@noetic/core';
import { Slot } from '@noetic/core';
import { isEnoent } from '../tasks/_fs-errors.js';

//#region Constants

/** Env var consulted at every recall — set by the task launcher per spawn. */
const TASK_DIR_ENV = 'NOETIC_TASK_DIR';

const STEERING_FILE_BASENAME = 'steering.md';

//#endregion

//#region Helpers

function joinPath(dir: string, file: string): string {
  if (dir.endsWith('/')) {
    return `${dir}${file}`;
  }
  return `${dir}/${file}`;
}

//#endregion

//#region Public API

/**
 * Create the steering-file memory layer.
 *
 * The layer carries no state; everything is resolved at recall time from the
 * `NOETIC_TASK_DIR` env var. Mounting it unconditionally is safe — when the
 * env var is unset, the layer no-ops.
 */
export function createSteeringFileLayer(): MemoryLayer<null> {
  return {
    id: 'steering-file',
    name: 'Task Steering File',
    slot: Slot.STEERING,
    scope: 'execution',
    budget: {
      min: 0,
      max: 8e3,
    },
    hooks: {
      async init() {
        return {
          state: null,
        };
      },

      async recall({ ctx }) {
        const taskDir = process.env[TASK_DIR_ENV];
        if (taskDir === undefined || taskDir.length === 0) {
          return null;
        }
        const filePath = joinPath(taskDir, STEERING_FILE_BASENAME);
        try {
          const content = await ctx.fs.readFileText(filePath);
          if (content.length === 0) {
            return null;
          }
          return `# Task Steering\n\n${content}`;
        } catch (err) {
          if (isEnoent(err)) {
            return null;
          }
          throw err;
        }
      },
    },
  };
}

//#endregion
