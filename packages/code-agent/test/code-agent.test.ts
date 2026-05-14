import { describe, expect, it } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentHarnessContract,
  CallModelRequest,
  LLMResponse,
  MessageItem,
} from '@noetic-tools/core';
import { channel } from '@noetic-tools/core';
import { z } from 'zod';
import { createCodeAgent, createCodingToolsPlugin, createTaskToolsPlugin } from '../src/index';

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {
    withFileTypes: true,
  });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return path.endsWith('.ts')
        ? [
            path,
          ]
        : [];
    }),
  );
  return nested.flat();
}

function response(text: string): LLMResponse {
  return {
    items: [
      {
        id: `msg-${crypto.randomUUID()}`,
        status: 'completed',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text,
          },
        ],
      } satisfies MessageItem,
    ],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
    },
  };
}

describe('createCodeAgent', () => {
  it('returns a harness-compatible superset', async () => {
    const agent = await createCodeAgent({
      model: 'test/model',
      modelAdapter: {
        async callModel(_request: CallModelRequest) {
          return response('done');
        },
      },
    });

    const harnessLike: AgentHarnessContract = agent;
    await harnessLike.execute('hello');
    const result = await harnessLike.getAgentResponse();
    const stream = harnessLike.getItemStream();

    expect(typeof stream[Symbol.asyncIterator]).toBe('function');
    expect(result.text).toBe('done');
    expect(agent.kind).toBe('code-agent');
    expect(agent.harness).toBeDefined();
  });

  it('uses portable in-memory adapters by default', async () => {
    const agent = await createCodeAgent({
      model: 'test/model',
      modelAdapter: {
        async callModel() {
          return response('ok');
        },
      },
    });

    await agent.fs.writeFile('/repo/file.txt', 'hello');
    expect(await agent.fs.readFileText('/repo/file.txt')).toBe('hello');

    const shell = await agent.shell.exec('echo hi', {
      cwd: '/',
    });
    expect(shell.exitCode).toBe(127);
  });

  it('collects plugin features without importing CLI concepts', async () => {
    const agent = await createCodeAgent({
      model: 'test/model',
      modelAdapter: {
        async callModel() {
          return response('ok');
        },
      },
      plugins: [
        {
          name: 'example',
          version: '0.0.0',
          skills: [
            {
              name: 'review',
              instructions: 'Review carefully.',
            },
          ],
        },
      ],
    });

    const task = await agent.tasks.create({
      title: 'Ship SDK',
    });
    await agent.tasks.update(task.id, {
      status: 'in_progress',
    });

    expect(agent.skills.get('review')?.instructions).toBe('Review carefully.');
    expect((await agent.tasks.get(task.id))?.status).toBe('in_progress');
  });

  it('does not import the CLI package or UI concepts', async () => {
    const files = await sourceFiles(join(import.meta.dir, '..', 'src'));
    const forbidden = [
      '@noetic/cli',
      'react',
      'ink',
    ];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const token of forbidden) {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(
          new RegExp(`from ['"]${escaped}['"]`).test(text),
          `${file} should not import ${token}`,
        ).toBe(false);
      }
    }
  });

  it('publishes through the channel controller and preserves harness channel behavior', async () => {
    const seen: string[] = [];
    const agent = await createCodeAgent({
      model: 'test/model',
      modelAdapter: {
        async callModel() {
          return response('ok');
        },
      },
      adapters: {
        channels: {
          publish(frame) {
            seen.push(String(frame.value));
          },
        },
      },
    });
    const ctx = agent.createContext();
    const testChannel = channel('test.channel', {
      mode: 'queue',
      schema: z.string(),
    });

    await agent.channels.publish(testChannel, 'hello', ctx);

    expect(await agent.channels.recv(testChannel, ctx)).toBe('hello');
    expect(seen).toEqual([
      'hello',
    ]);
  });

  it('uses channel and task adapters when supplied', async () => {
    const published: string[] = [];
    const created: string[] = [];
    const agent = await createCodeAgent({
      model: 'test/model',
      modelAdapter: {
        async callModel() {
          return response('ok');
        },
      },
      adapters: {
        channels: {
          publish(frame) {
            published.push(String(frame.value));
          },
        },
        tasks: {
          async list() {
            return [];
          },
          async create(input) {
            created.push(input.title);
            return {
              id: 'adapter-task',
              title: input.title,
              body: input.body ?? '',
              status: input.status ?? 'todo',
              createdAt: '2026-05-02T00:00:00.000Z',
              updatedAt: '2026-05-02T00:00:00.000Z',
            };
          },
          async update() {
            throw new Error('not used');
          },
          async get() {
            return null;
          },
        },
      },
    });
    const adapterChannel = channel('adapter.channel', {
      mode: 'topic',
      schema: z.string(),
    });

    await agent.channels.publish(adapterChannel, 'event');
    const task = await agent.tasks.create({
      title: 'adapter-backed',
    });

    expect(published).toEqual([
      'event',
    ]);
    expect(created).toEqual([
      'adapter-backed',
    ]);
    expect(task.id).toBe('adapter-task');
  });

  it('provides SDK-native coding and task tools as plugins', async () => {
    const agent = await createCodeAgent({
      model: 'test/model',
      cwd: '/repo',
      modelAdapter: {
        async callModel() {
          return response('ok');
        },
      },
      plugins: [
        createCodingToolsPlugin(),
        createTaskToolsPlugin(),
      ],
    });
    const ctx = agent.createContext();
    const toolCtx = {
      ctx,
      harness: agent,
      fs: agent.fs,
      shell: agent.shell,
      memory: {
        get: () => undefined,
        set: () => undefined,
      },
      assembledView: [],
      lastStepMeta: null,
    };
    const tools = agent.tools.list();
    const read = tools.find((candidate) => candidate.name === 'Read');
    const write = tools.find((candidate) => candidate.name === 'Write');
    const list = tools.find((candidate) => candidate.name === 'List');
    const taskCreate = tools.find((candidate) => candidate.name === 'TaskCreate');
    const taskList = tools.find((candidate) => candidate.name === 'TaskList');

    expect(read).toBeDefined();
    expect(write).toBeDefined();
    expect(list).toBeDefined();
    expect(taskCreate).toBeDefined();
    expect(taskList).toBeDefined();

    await write!.execute(
      {
        path: 'src/a.txt',
        content: 'hello',
      },
      toolCtx,
    );
    const readResult = await read!.execute(
      {
        path: 'src/a.txt',
      },
      toolCtx,
    );
    const listResult = await list!.execute(
      {
        path: 'src',
      },
      toolCtx,
    );
    await taskCreate!.execute(
      {
        title: 'from tool',
      },
      toolCtx,
    );
    const taskListResult = await taskList!.execute({}, toolCtx);

    expect(readResult).toEqual({
      path: '/repo/src/a.txt',
      content: 'hello',
    });
    expect(listResult).toEqual({
      path: '/repo/src',
      entries: [
        'a.txt',
      ],
    });
    expect(taskListResult).toEqual({
      tasks: [
        expect.objectContaining({
          title: 'from tool',
        }),
      ],
    });
  });
});

describe('portable task adapters', () => {
  it('imports portable task subpaths without Node-only modules', async () => {
    const tasks = await import('../src/tasks/index.js');
    const execution = await import('../src/tasks/execution.js');
    const memoryStore = await import('../src/tasks/store-memory.js');
    const transport = await import('../src/tasks/subprocess-transport-memory.js');

    const store = memoryStore.createMemoryTaskStore();
    const agent = await createCodeAgent({
      model: 'test/model',
      modelAdapter: {
        async callModel() {
          return response('ok');
        },
      },
    });
    const taskExecution = execution.createTaskExecutionAdapter({
      store,
      subprocess: agent.harness.subprocess,
    });
    const task = await store.createTask({
      title: 'portable',
      projectRoot: '/repo',
    });
    const record = await taskExecution.start({
      role: 'planner',
      taskId: task.id,
      command: 'planner',
      cwd: '/repo',
    });
    const bus = transport.createInMemoryTaskRunTransport();
    const seen: unknown[] = [];
    bus.subscribe(record.subprocess.id, (frame) => seen.push(frame.payload));
    await bus.publish({
      runId: record.subprocess.id,
      type: 'status',
      payload: 'running',
    });

    expect(tasks.TaskSource.Manual).toBe('manual');
    expect(record.subprocess.metadata?.runtime).toBe('in-memory');
    expect(await taskExecution.isAlive(record.subprocess)).toBe(false);
    expect((await taskExecution.get(record.subprocess.id))?.status).toBe('completed');
    expect(await bus.history(record.subprocess.id)).toHaveLength(1);
    expect(seen).toEqual([
      'running',
    ]);
  });
});
