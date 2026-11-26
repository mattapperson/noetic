/**
 * Registry entry the step-bootstrap test's child imports: one step that names
 * a harness adapter, one that names none.
 */

import type { AcpAgent } from '@noetic-tools/types';
import { runCode, step } from '../../src/builders/step-builders';
import { registerStep } from '../../src/runtime/step-registry';

const agent: AcpAgent = {
  specificationVersion: 'acp-v1',
  agentId: 'never-started',
  async connect() {
    throw new Error('the agent must not start');
  },
};

registerStep(
  step.acpAgent({
    id: 'bootstrap/named',
    agent,
    prompt: 'go',
    subprocess: 'builder',
  }),
);

registerStep(
  runCode({
    id: 'bootstrap/unnamed',
    execute: async (_input: unknown, ctx) => {
      await ctx.fs.writeFile('/note.txt', 'kept in memory');
      return {
        fs: ctx.adapters.fs.list().map((adapter) => adapter.name),
        note: await ctx.fs.readFileText('/note.txt'),
      };
    },
  }),
);
