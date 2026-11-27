// A JSON workflow's declarative replayKey replays leaves by content, so workers whose
// batches swap between runs each get their own batch's answer. See spec 26 § Replay keys.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  ExecuteStepFn,
  ProcessSubprocessRequest,
  SpawnedSubprocess,
  SubprocessAdapter,
  SubprocessHandle,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import { hydrateWorkflow } from '../../src/builders/workflow-source';
import { workflow } from '../../src/builders/workflow-step';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { WorkflowDocument, WorkflowNode } from '../../src/schemas/workflow';
import { validateWorkflow } from '../../src/schemas/workflow';

interface SandboxState {
  queue: string[];
  graded: string[];
}

/**
 * A sandbox that runs two programs: `pick` pops the next batch off a shared queue
 * (which batch a worker gets depends on timing), and `grade` answers for the batch on
 * stdin. `graded` records every paid call.
 */
function sandbox(state: SandboxState): SubprocessAdapter {
  let count = 0;
  const programs: Record<string, (stdin: string) => string> = {
    pick: () => state.queue.shift() ?? 'drained',
    grade: (stdin) => {
      state.graded.push(stdin);
      return `answer-${stdin}`;
    },
  };
  return frameworkCast<SubprocessAdapter>({
    async spawn(request: ProcessSubprocessRequest): Promise<SpawnedSubprocess> {
      const handle: SubprocessHandle = {
        id: `sandbox-${count++}`,
        status: 'running',
        startedAt: 'now',
      };
      const program = programs[String(request.metadata?.code)];
      return {
        handle,
        settled: Promise.resolve({
          ...handle,
          status: 'completed',
          metadata: {
            result: program?.(request.stdin ?? ''),
          },
        }),
      };
    },
  });
}

/** Two workers, each picking a batch and grading it with the same `grade` leaf. */
function workerPool(): WorkflowDocument {
  const worker = (id: string): WorkflowNode => ({
    kind: 'sequence',
    id,
    durable: false,
    steps: [
      {
        kind: 'runCode',
        id: `${id}-pick`,
        durable: false,
        execute: 'pick',
        subprocess: 'sandbox',
      },
      {
        kind: 'runCode',
        id: 'grade',
        execution: {
          durable: true,
          replayKey: true,
          retry: {
            maxAttempts: 2,
            backoff: 'fixed',
            initialDelay: 0,
          },
        },
        execute: 'grade',
        subprocess: 'sandbox',
      },
    ],
  });
  return validateWorkflow({
    version: 1,
    root: {
      kind: 'inParallel',
      id: 'pool',
      mode: 'all',
      durable: false,
      merge: 'concat',
      paths: [
        worker('worker-a'),
        worker('worker-b'),
      ],
    },
  });
}

describe('JSON replayKey', () => {
  it.each([
    'lost',
    'failed',
    'exit-code',
  ])('handles a document command reporting %s', async (mode) => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    let writes = 0;
    const adapter: SubprocessAdapter = {
      ...createInMemorySubprocessAdapter(),
      async spawn(request) {
        assert(request.kind === 'process');
        writes++;
        if (mode === 'lost') {
          throw new Error('the command started but the launch reply was lost');
        }
        const handle: SubprocessHandle = {
          id: 'fixture',
          status: 'running',
          startedAt: 'now',
        };
        return {
          handle,
          settled: Promise.resolve({
            ...handle,
            status: 'failed',
            metadata: {
              error: {
                message: 'command exited 7',
              },
              exitCode: mode === 'exit-code' ? 7 : undefined,
            },
          }),
        };
      },
    };
    const build = () =>
      new AgentHarness({
        name: 'json-command',
        params: {},
        agentGraph: workflow({
          id: 'flow',
          document: {
            version: 1,
            root: {
              id: 'command',
              kind: 'runCode',
              execute: 'write',
              subprocess: 'sandbox',
              execution: {
                retry: {
                  maxAttempts: 2,
                  backoff: 'fixed',
                  initialDelay: 0,
                },
              },
            },
          },
          resolveSubprocess: () => adapter,
        }),
        environment: {
          storage: {
            adapter: storage,
          },
        },
      });
    const delivery = {
      threadId: 't',
      messageId: 'same',
    };
    const first = build();
    const second = build();
    const unknown = {
      noeticError: {
        kind: 'subprocess_outcome_unknown',
      },
    };
    try {
      await first.execute('start', delivery);
      if (mode !== 'lost') {
        await expect(first.getAgentResponse(delivery)).rejects.toThrow('command exited 7');
        expect(writes).toBe(mode === 'exit-code' ? 2 : 1);
        return;
      }
      await expect(first.getAgentResponse(delivery)).rejects.toMatchObject(unknown);
      await second.execute('start', delivery);
      await expect(second.getAgentResponse(delivery)).rejects.toMatchObject(unknown);
      expect(writes).toBe(1);
    } finally {
      await Promise.all([
        first.close(),
        second.close(),
      ]);
    }
  });

  it('replays each worker its own batch when batches swap between runs', async () => {
    const storage = createInMemoryStorage();
    const harness = new AgentHarness({
      name: 'json-replay',
      params: {},
      environment: {
        storage: {
          adapter: storage,
          checkpointStore: createCheckpointStore({
            storage,
          }),
        },
      },
    });
    const state: SandboxState = {
      queue: [
        'b1',
        'b2',
      ],
      graded: [],
    };
    const adapter = sandbox(state);
    const pool = hydrateWorkflow(workerPool(), {
      tools: new Map(),
      executeStep: frameworkCast<ExecuteStepFn>(harness.run.bind(harness)),
      resolveSubprocess: (ref) => (ref === 'sandbox' ? adapter : undefined),
    });

    const ctx = harness.createContext();
    const first = String(await harness.run(pool, 'go', ctx));
    expect(first).toContain('answer-b1');
    expect(first).toContain('answer-b2');
    expect(state.graded.sort()).toEqual([
      'b1',
      'b2',
    ]);

    // Worker A now picks b2 and worker B picks b1: positional replay would swap answers.
    state.queue = [
      'b2',
      'b1',
    ];
    state.graded = [];
    const resumed = await harness.restore(ctx.id);
    expect(resumed).not.toBeNull();
    const second = String(await harness.run(pool, 'go', frameworkCast(resumed)));

    expect(state.graded).toEqual([]);
    expect(second.indexOf('answer-b2')).toBeLessThan(second.indexOf('answer-b1'));
    expect(state.queue).toEqual([]);
  });
});
