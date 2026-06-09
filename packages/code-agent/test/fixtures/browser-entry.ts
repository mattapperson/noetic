import { createCodeAgent, createCodingToolsPlugin, createTaskToolsPlugin } from '../../src/index';
import { createTaskExecutionAdapter } from '../../src/tasks/execution';
import { createMemoryTaskStore } from '../../src/tasks/store-memory';
import { createInMemoryTaskRunTransport } from '../../src/tasks/subprocess-transport-memory';

const agent = await createCodeAgent({
  model: 'test/model',
  cwd: '/browser',
  modelAdapter: {
    async callModel() {
      return {
        items: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      };
    },
  },
  plugins: [
    createCodingToolsPlugin(),
    createTaskToolsPlugin(),
  ],
});

const write = agent.tools.get('Write');
const read = agent.tools.get('Read');
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

await write?.execute(
  {
    path: 'browser.txt',
    content: 'ok',
  },
  toolCtx,
);
const result = await read?.execute(
  {
    path: 'browser.txt',
  },
  toolCtx,
);
const taskStore = createMemoryTaskStore();
const task = await taskStore.createTask({
  title: 'browser task',
  projectRoot: '/browser',
});
const execution = createTaskExecutionAdapter({
  store: taskStore,
  subprocess: agent.harness.subprocess,
});
const run = await execution.start({
  role: 'planner',
  taskId: task.id,
  command: 'planner',
  cwd: '/browser',
});
const transport = createInMemoryTaskRunTransport();
await transport.publish({
  runId: run.subprocess.id,
  type: 'status',
  payload: run.subprocess.status,
});

globalThis.dispatchEvent(
  new CustomEvent('noetic-code-agent-ready', {
    detail: {
      result,
      task,
      run,
      frames: await transport.history(run.subprocess.id),
    },
  }),
);
