import {
  createCodeAgent,
  createCodingToolsPlugin,
  createTaskToolsPlugin,
} from '../../../src/index';

export default {
  async fetch(): Promise<Response> {
    const agent = await createCodeAgent({
      model: 'test/model',
      cwd: '/worker',
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
    const write = agent.tools.get('Write');
    const read = agent.tools.get('Read');
    const taskCreate = agent.tools.get('TaskCreate');

    await write?.execute(
      {
        path: 'worker.txt',
        content: 'ok',
      },
      toolCtx,
    );
    const file = await read?.execute(
      {
        path: 'worker.txt',
      },
      toolCtx,
    );
    const task = await taskCreate?.execute(
      {
        title: 'worker-task',
      },
      toolCtx,
    );
    return Response.json({
      kind: agent.kind,
      fs: file,
      task,
      status: agent.getStatus().kind,
    });
  },
};
