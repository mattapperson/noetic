import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Connection, ConnectionTaskStatus } from '@noetic-tools/types';
import type { TaskRecord } from './_helpers';
import { connectOptions, createdTask, structured, TestServer, waitFor } from './_helpers';

const opened: Connection[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.release()));
});

const signal = new AbortController().signal;

function taskServer(task: TaskRecord): TestServer {
  const fixture: TestServer = new TestServer({
    tasks: true,
    tools: [
      {
        name: 'install',
        taskSupport: 'required',
        handler: () => {
          fixture.tasks.set('t1', task);
          return createdTask('t1');
        },
      },
      {
        name: 'quick',
        handler: () =>
          structured({
            done: true,
          }),
      },
    ],
  });
  return fixture;
}

async function connect(fixture: TestServer): Promise<Connection> {
  const [connection] = await fixture.provider().connect(connectOptions('device'));
  assert(connection !== undefined);
  opened.push(connection);
  return connection;
}

function working(): TaskRecord {
  return {
    status: 'working',
    responses: [],
  };
}

describe('long-running operations (Tasks extension)', () => {
  it('returns a task for a tool that runs as one, and asks for task execution', async () => {
    const fixture = taskServer(working());
    const connection = await connect(fixture);
    const result = await connection.call(
      'install',
      {},
      {
        signal,
        idempotencyKey: 'k1',
      },
    );
    expect(result).toEqual({
      status: 'task',
      taskId: 't1',
    });
    const quick = await connection.call(
      'quick',
      {},
      {
        signal,
        idempotencyKey: 'k2',
      },
    );
    expect(quick.status).toBe('ok');
  });

  it('reports progress and the final result', async () => {
    const task = working();
    const fixture = taskServer(task);
    const connection = await connect(fixture);
    await connection.call(
      'install',
      {},
      {
        signal,
        idempotencyKey: 'k1',
      },
    );
    const seen: ConnectionTaskStatus[] = [];
    const outcome = connection.tasks.result('t1', {
      signal,
      onProgress: (status) => {
        seen.push(status);
      },
    });
    await waitFor(() => seen.length === 1);
    task.progress = {
      current: 1,
      total: 2,
    };
    task.statusMessage = 'copying';
    await fixture.notifyAll('notifications/tasks/status', {
      taskId: 't1',
    });
    await waitFor(() => seen.length === 2);
    task.status = 'completed';
    task.result = structured({
      app: 'com.example',
    });
    expect(await outcome).toEqual({
      status: 'ok',
      output: {
        app: 'com.example',
      },
    });
    expect(seen[1]).toEqual({
      taskId: 't1',
      state: 'working',
      message: 'copying',
      progress: {
        current: 1,
        total: 2,
      },
    });
    expect(seen.at(-1)?.state).toBe('completed');
  });

  it('surfaces input_required and answers it with tasks/update', async () => {
    const task = working();
    task.status = 'input_required';
    task.inputRequests = {
      r1: {
        message: 'Which simulator?',
      },
    };
    const fixture = taskServer(task);
    const connection = await connect(fixture);
    await connection.call(
      'install',
      {},
      {
        signal,
        idempotencyKey: 'k1',
      },
    );
    const status = await connection.tasks.get('t1', {
      signal,
    });
    expect(status.state).toBe('input_required');
    expect(status.request).toEqual({
      id: 'r1',
      message: 'Which simulator?',
    });
    await connection.tasks.respond('t1', 'r1', {
      name: 'iPhone 17',
    });
    expect(task.responses).toEqual([
      {
        r1: {
          name: 'iPhone 17',
        },
      },
    ]);
  });

  it('maps a failed task to its error and a cancelled one to unavailable', async () => {
    const task = working();
    task.status = 'failed';
    task.error = {
      code: 'busy',
      message: 'simulator busy',
    };
    const fixture = taskServer(task);
    const connection = await connect(fixture);
    await connection.call(
      'install',
      {},
      {
        signal,
        idempotencyKey: 'k1',
      },
    );
    expect(
      await connection.tasks.result('t1', {
        signal,
      }),
    ).toEqual({
      status: 'error',
      error: {
        code: 'busy',
        message: 'simulator busy',
      },
    });
    task.status = 'failed';
    task.error = {
      message: 'no code',
    };
    const uncoded = await connection.tasks.result('t1', {
      signal,
    });
    assert(uncoded.status === 'error');
    expect(uncoded.error.code).toBe('unavailable');
    await connection.tasks.cancel('t1');
    expect(fixture.tasks.get('t1')?.status).toBe('cancelled');
    const cancelled = await connection.tasks.result('t1', {
      signal,
    });
    assert(cancelled.status === 'error');
    expect(cancelled.error.code).toBe('unavailable');
  });

  it('maps a completed task whose result is a tool error to that error', async () => {
    const task = working();
    task.status = 'completed';
    task.result = {
      isError: true,
      content: [],
      structuredContent: {
        code: 'conflict',
        message: 'already installed',
      },
    };
    const fixture = taskServer(task);
    const connection = await connect(fixture);
    await connection.call(
      'install',
      {},
      {
        signal,
        idempotencyKey: 'k1',
      },
    );
    const outcome = await connection.tasks.result('t1', {
      signal,
    });
    assert(outcome.status === 'error');
    expect(outcome.error.code).toBe('conflict');
  });

  it('stops waiting when the signal aborts', async () => {
    const fixture = taskServer(working());
    const connection = await connect(fixture);
    await connection.call(
      'install',
      {},
      {
        signal,
        idempotencyKey: 'k1',
      },
    );
    const controller = new AbortController();
    const waiting = connection.tasks.result('t1', {
      signal: controller.signal,
    });
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
  });
});
