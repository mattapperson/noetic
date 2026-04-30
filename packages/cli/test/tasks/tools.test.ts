/**
 * Unit tests for `taskTools()` — the agent-facing wrappers around the
 * Phase-7 verb handlers. Tests cover:
 *   - the default tool count + name set (23 mutators + readers)
 *   - read-only mode trims to the three observation tools
 *   - input-schema rejection on malformed args (Zod validation)
 *   - happy-path mutators actually mutate state via MemFs round-trip
 */

import { describe, expect, it } from 'bun:test';
import type { ToolExecutionContext } from '@noetic/core';
import { z } from 'zod';

import { listTasks, loadTask } from '../../src/commands/builtins/tasks/fs-store.js';
import { createTaskHandler } from '../../src/commands/builtins/tasks/handlers/create.js';
import { READ_ONLY_TASK_TOOL_NAMES, taskTools } from '../../src/commands/builtins/tasks/tools.js';
import { makeStoreContext } from './_helpers.js';

//#region Constants

const EXPECTED_TOOL_NAMES: ReadonlyArray<string> = [
  'task_show',
  'task_list',
  'task_logs',
  'task_create',
  'task_move',
  'task_log',
  'task_attach',
  'task_comment',
  'task_steer',
  'task_pause',
  'task_unpause',
  'task_archive',
  'task_unarchive',
  'task_delete',
  'task_duplicate',
  'task_merge',
  'task_plan',
  'task_add_milestone',
  'task_add_slice',
  'task_add_feature',
  'task_add_assertion',
  'task_activate_slice',
  'task_autopilot',
];

const EXPECTED_DEFAULT_COUNT = 23;

//#endregion

//#region Helpers

function makeStubExecutionContext(): ToolExecutionContext {
  const empty: ToolExecutionContext = Object.create(null);
  return empty;
}

interface ResultEnvelope {
  ok: boolean;
  data?: unknown;
  error?: string;
}

const ResultEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

function isResultEnvelope(value: unknown): value is ResultEnvelope {
  return ResultEnvelopeSchema.safeParse(value).success;
}

interface ToolRunResult {
  envelope: ResultEnvelope;
}

async function runTool(
  tools: ReturnType<typeof taskTools>,
  name: string,
  args: unknown,
): Promise<ToolRunResult> {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(`Tool ${name} not found in pool`);
  }
  // Validate inputs through the tool's own Zod schema, exactly mirroring
  // what the harness does before invoking `execute()`.
  const parsed = found.input.parse(args);
  const exec = found.execute(parsed, makeStubExecutionContext());
  const value = await Promise.resolve(exec);
  if (!isResultEnvelope(value)) {
    throw new Error(`Tool ${name} did not return a ResultEnvelope`);
  }
  return {
    envelope: value,
  };
}

// Narrow shapes used by the happy-path tests below. Defined as Zod schemas
// (not type-asserted) so we keep type safety without `as` casts.
const LogsDataSchema = z.object({
  entries: z.array(
    z
      .object({
        message: z.string(),
      })
      .passthrough(),
  ),
});

const ShowDataSchema = z.object({
  hierarchy: z
    .object({
      milestones: z.array(
        z
          .object({
            title: z.string(),
          })
          .passthrough(),
      ),
    })
    .passthrough()
    .nullable(),
});

//#endregion

//#region Composition tests

describe('taskTools() composition', () => {
  it('returns the full set of 23 tools by default', () => {
    const ctx = makeStoreContext();
    const tools = taskTools({
      ctx,
    });
    expect(tools.length).toBe(EXPECTED_DEFAULT_COUNT);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        ...EXPECTED_TOOL_NAMES,
      ].sort(),
    );
  });

  it('returns only the three readers when readOnly=true', () => {
    const ctx = makeStoreContext();
    const tools = taskTools({
      ctx,
      readOnly: true,
    });
    expect(tools.length).toBe(3);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        ...READ_ONLY_TASK_TOOL_NAMES,
      ].sort(),
    );
  });

  it('omits every mutator name in readOnly mode', () => {
    const ctx = makeStoreContext();
    const readers = taskTools({
      ctx,
      readOnly: true,
    });
    const readerNameSet = new Set(readers.map((t) => t.name));
    const mutatorNames = EXPECTED_TOOL_NAMES.filter((n) => !READ_ONLY_TASK_TOOL_NAMES.includes(n));
    for (const name of mutatorNames) {
      expect(readerNameSet.has(name)).toBe(false);
    }
  });

  it('every tool exposes a non-empty description and Zod schemas', () => {
    const ctx = makeStoreContext();
    const tools = taskTools({
      ctx,
    });
    for (const t of tools) {
      expect(t.name.startsWith('task_')).toBe(true);
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.input.parse).toBe('function');
      expect(typeof t.output.parse).toBe('function');
    }
  });
});

//#endregion

//#region Schema rejection

describe('taskTools() — input schema rejection', () => {
  it('task_create rejects an empty title', () => {
    const ctx = makeStoreContext();
    const tools = taskTools({
      ctx,
    });
    const create = tools.find((t) => t.name === 'task_create');
    if (create === undefined) {
      throw new Error('task_create missing');
    }
    expect(() =>
      create.input.parse({
        title: '',
      }),
    ).toThrow();
  });

  it('task_show rejects a malformed task id', () => {
    const ctx = makeStoreContext();
    const tools = taskTools({
      ctx,
    });
    const show = tools.find((t) => t.name === 'task_show');
    if (show === undefined) {
      throw new Error('task_show missing');
    }
    expect(() =>
      show.input.parse({
        taskId: 'not-a-task-id',
      }),
    ).toThrow();
  });

  it('task_move rejects an unknown column', () => {
    const ctx = makeStoreContext();
    const tools = taskTools({
      ctx,
    });
    const move = tools.find((t) => t.name === 'task_move');
    if (move === undefined) {
      throw new Error('task_move missing');
    }
    expect(() =>
      move.input.parse({
        taskId: 'T-AAAAAAAAAA',
        column: 'not-a-column',
      }),
    ).toThrow();
  });

  it('task_autopilot rejects a non-boolean enabled flag', () => {
    const ctx = makeStoreContext();
    const tools = taskTools({
      ctx,
    });
    const autopilot = tools.find((t) => t.name === 'task_autopilot');
    if (autopilot === undefined) {
      throw new Error('task_autopilot missing');
    }
    expect(() =>
      autopilot.input.parse({
        taskId: 'T-AAAAAAAAAA',
        enabled: 'yes',
      }),
    ).toThrow();
  });

  it('task_add_slice rejects a malformed milestone id', () => {
    const ctx = makeStoreContext();
    const tools = taskTools({
      ctx,
    });
    const addSlice = tools.find((t) => t.name === 'task_add_slice');
    if (addSlice === undefined) {
      throw new Error('task_add_slice missing');
    }
    expect(() =>
      addSlice.input.parse({
        taskId: 'T-AAAAAAAAAA',
        milestoneId: 'M-bad',
        title: 'x',
        verification: 'v',
      }),
    ).toThrow();
  });
});

//#endregion

//#region Happy-path mutation observability

describe('taskTools() — happy-path mutation', () => {
  it('task_create persists a task that loadTask can read back', async () => {
    const ctx = makeStoreContext();
    const tools = taskTools({
      ctx,
    });
    const { envelope } = await runTool(tools, 'task_create', {
      title: 'Wired through tool',
      description: 'Created via the agent surface',
    });
    expect(envelope.ok).toBe(true);
    const tasks = await listTasks(ctx);
    expect(tasks.length).toBe(1);
    const task = tasks[0];
    if (task === undefined) {
      throw new Error('expected one task');
    }
    expect(task.title).toBe('Wired through tool');
    const reloaded = await loadTask(ctx, task.id);
    expect(reloaded.id).toBe(task.id);
  });

  it('task_move flips a task into a different column', async () => {
    const ctx = makeStoreContext();
    const seeded = await createTaskHandler(ctx, {
      title: 'Seeded for move',
    });
    const tools = taskTools({
      ctx,
    });
    const { envelope } = await runTool(tools, 'task_move', {
      taskId: seeded.task.id,
      column: 'in_progress',
    });
    expect(envelope.ok).toBe(true);
    const reloaded = await loadTask(ctx, seeded.task.id);
    // Moving a never-reviewed task into in_progress flips reviewStatus to 'reviewing'.
    expect(reloaded.reviewStatus).toBe('reviewing');
  });

  it('task_archive sets archivedAt on the persisted task', async () => {
    const ctx = makeStoreContext();
    const seeded = await createTaskHandler(ctx, {
      title: 'Seeded for archive',
    });
    const tools = taskTools({
      ctx,
    });
    const { envelope } = await runTool(tools, 'task_archive', {
      taskId: seeded.task.id,
    });
    expect(envelope.ok).toBe(true);
    const reloaded = await loadTask(ctx, seeded.task.id);
    expect(reloaded.archivedAt).not.toBeNull();
  });

  it('task_log appends an entry visible via task_logs', async () => {
    const ctx = makeStoreContext();
    const seeded = await createTaskHandler(ctx, {
      title: 'Seeded for log',
    });
    const tools = taskTools({
      ctx,
    });
    const { envelope: logEnv } = await runTool(tools, 'task_log', {
      taskId: seeded.task.id,
      message: 'investigated tail latency',
    });
    expect(logEnv.ok).toBe(true);
    const { envelope: logsEnv } = await runTool(tools, 'task_logs', {
      taskId: seeded.task.id,
    });
    expect(logsEnv.ok).toBe(true);
    const logsData = LogsDataSchema.parse(logsEnv.data);
    const messages = logsData.entries.map((e) => e.message);
    expect(messages).toContain('investigated tail latency');
  });

  it('task_autopilot toggles autopilotEnabled on the persisted task', async () => {
    const ctx = makeStoreContext();
    const seeded = await createTaskHandler(ctx, {
      title: 'Seeded for autopilot',
    });
    expect(seeded.task.autopilotEnabled).toBe(false);
    const tools = taskTools({
      ctx,
    });
    const { envelope } = await runTool(tools, 'task_autopilot', {
      taskId: seeded.task.id,
      enabled: true,
    });
    expect(envelope.ok).toBe(true);
    const reloaded = await loadTask(ctx, seeded.task.id);
    expect(reloaded.autopilotEnabled).toBe(true);
  });

  it('task_add_milestone appends a milestone visible via task_show', async () => {
    const ctx = makeStoreContext();
    const seeded = await createTaskHandler(ctx, {
      title: 'Seeded for add-milestone',
    });
    const tools = taskTools({
      ctx,
    });
    const addEnv = await runTool(tools, 'task_add_milestone', {
      taskId: seeded.task.id,
      title: 'Ship MVP',
      verification: 'demo passes',
    });
    expect(addEnv.envelope.ok).toBe(true);

    const showEnv = await runTool(tools, 'task_show', {
      taskId: seeded.task.id,
    });
    expect(showEnv.envelope.ok).toBe(true);
    const showData = ShowDataSchema.parse(showEnv.envelope.data);
    if (showData.hierarchy === null) {
      throw new Error('expected non-null hierarchy in show envelope');
    }
    const titles = showData.hierarchy.milestones.map((m) => m.title);
    expect(titles).toContain('Ship MVP');
  });

  it('returns ok=false when the underlying handler throws (unknown task id)', async () => {
    const ctx = makeStoreContext();
    const tools = taskTools({
      ctx,
    });
    const { envelope } = await runTool(tools, 'task_show', {
      taskId: 'T-AAAAAAAAAA',
    });
    expect(envelope.ok).toBe(false);
    expect(typeof envelope.error).toBe('string');
  });
});

//#endregion
