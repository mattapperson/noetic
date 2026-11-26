// What a document's runCode nodes may ask (spec 26 § runCode): a node names a
// harness subprocess adapter only when the host's `runCode` grant lists it.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  CallModelRequest,
  ProcessSubprocessRequest,
  RunCodeGrant,
  SpawnedSubprocess,
  SubprocessAdapter,
  SubprocessHandle,
  WorkflowDocument,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import { dynamicWorkflow, parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { hydrateNode } from '../../src/builders/workflow-hydrator';
import { AgentHarness } from '../../src/harness/agent-harness';
import { makeLLMResponse } from '../_helpers';

//#region Helpers

/** A subprocess adapter that answers each request with its name and records them. */
function host(name: string): {
  adapter: SubprocessAdapter;
  calls: ProcessSubprocessRequest[];
} {
  const calls: ProcessSubprocessRequest[] = [];
  const steps = createInMemorySubprocessAdapter();
  const adapter: SubprocessAdapter = {
    get: (id) => steps.get(id),
    stop: (id, reason) => steps.stop(id, reason),
    pause: (id) => steps.pause(id),
    resume: (id) => steps.resume(id),
    isAlive: (handle) => steps.isAlive(handle),
    reattach: (id) => steps.reattach(id),
    listLive: () => steps.listLive(),
    async spawn(request): Promise<SpawnedSubprocess> {
      // The harness runs its steps through this adapter too.
      if (request.kind !== 'process') {
        return await steps.spawn(request);
      }
      calls.push(request);
      const handle: SubprocessHandle = {
        id: `${name}-${calls.length}`,
        status: 'running',
        startedAt: 'now',
      };
      return {
        handle,
        settled: Promise.resolve({
          ...handle,
          status: 'completed',
          metadata: {
            result: name,
          },
        }),
      };
    },
  };
  return {
    adapter,
    calls,
  };
}

interface Hosts {
  harness: AgentHarness;
  sandbox: ReturnType<typeof host>;
  machine: ReturnType<typeof host>;
}

/** A harness with a `sandbox` (the default) and a `machine` subprocess adapter. */
function twoHosts(planned?: WorkflowDocument, requests: CallModelRequest[] = []): Hosts {
  const sandbox = host('sandbox');
  const machine = host('machine');
  const harness = new AgentHarness({
    name: 'run-code-grant',
    params: {},
    environment: {
      subprocess: {
        sandbox: {
          adapter: sandbox.adapter,
          default: true,
        },
        machine: {
          adapter: machine.adapter,
        },
      },
    },
    ...(planned
      ? {
          _testCallModel: async (request: CallModelRequest) => {
            requests.push(request);
            return makeLLMResponse(JSON.stringify(planned));
          },
        }
      : {}),
  });
  return {
    harness,
    sandbox,
    machine,
  };
}

function docOn(subprocess?: string): WorkflowDocument {
  return {
    version: 1,
    root: {
      kind: 'runCode',
      id: 'compute',
      execute: 'code',
      ...(subprocess === undefined
        ? {}
        : {
            subprocess,
          }),
    },
  };
}

function runDocument(hosts: Hosts, subprocess?: string, runCode?: RunCodeGrant): Promise<string> {
  return parseAndRunWorkflow({
    json: docOn(subprocess),
    harness: hosts.harness,
    ctx: hosts.harness.createContext(),
    tools: [],
    runCode,
  });
}

function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

async function refusal(run: Promise<unknown>, code: string): Promise<string> {
  const error = rootCause(await run.catch((e: unknown) => e));
  assert(isNoeticConfigError(error));
  expect(error.code).toBe(code);
  return `${error.message} ${error.hint}`;
}

//#endregion

describe("a document's runCode node — parseAndRunWorkflow", () => {
  it('runs on the default adapter when it names none', async () => {
    const hosts = twoHosts();
    expect(await runDocument(hosts)).toBe('sandbox');
    expect(hosts.machine.calls).toHaveLength(0);
  });

  it('refuses a harness adapter name with no grant, running nothing', async () => {
    const hosts = twoHosts();
    const said = await refusal(runDocument(hosts, 'machine'), 'CONNECTION_NOT_ALLOWED');
    expect(hosts.machine.calls).toHaveLength(0);
    expect(hosts.sandbox.calls).toHaveLength(0);
    // The document's author learns no adapter name the document did not give.
    expect(said).not.toContain('sandbox');
  });

  it('refuses a name the grant does not list', async () => {
    const hosts = twoHosts();
    const said = await refusal(
      runDocument(hosts, 'machine', {
        subprocess: [
          'sandbox',
        ],
      }),
      'CONNECTION_NOT_ALLOWED',
    );
    expect(hosts.machine.calls).toHaveLength(0);
    expect(said).toContain('sandbox');
  });

  it('runs on a named adapter the grant lists', async () => {
    const hosts = twoHosts();
    expect(
      await runDocument(hosts, 'machine', {
        subprocess: [
          'machine',
        ],
      }),
    ).toBe('machine');
    expect(hosts.sandbox.calls).toHaveLength(0);
  });

  it('fails a granted name the harness lacks without listing the names it has', async () => {
    const hosts = twoHosts();
    const said = await refusal(
      runDocument(hosts, 'cloud', {
        subprocess: [
          'cloud',
        ],
      }),
      'UNKNOWN_SUBPROCESS_REFERENCE',
    );
    expect(said).not.toContain('sandbox');
    expect(said).not.toContain('machine');
  });
});

describe("a document's runCode node — dynamicWorkflow", () => {
  it('refuses a harness adapter name with no grant', async () => {
    const hosts = twoHosts(docOn('machine'));
    await refusal(
      hosts.harness.run(
        dynamicWorkflow({
          tools: [],
          maxRevisions: 1,
        }),
        'do it',
        hosts.harness.createContext(),
      ),
      'CONNECTION_NOT_ALLOWED',
    );
    expect(hosts.machine.calls).toHaveLength(0);
  });

  it('runs on a named adapter the grant lists, and shows the planner the grant', async () => {
    const requests: CallModelRequest[] = [];
    const hosts = twoHosts(docOn('machine'), requests);
    await hosts.harness.run(
      dynamicWorkflow({
        tools: [],
        runCode: {
          subprocess: [
            'machine',
          ],
        },
      }),
      'do it',
      hosts.harness.createContext(),
    );
    expect(hosts.machine.calls).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('machine');
  });
});

describe('a hydrated runCode node held to a grant', () => {
  const node = {
    kind: 'runCode',
    id: 'compute',
    execute: 'code',
    subprocess: 'machine',
  } as const;

  it('refuses an ungranted harness adapter name when it runs', async () => {
    const hosts = twoHosts();
    const hydrated = hydrateNode(node, {
      tools: new Map(),
      executeStep: async (_step, input) => frameworkCast(input),
      runCodeBounds: {},
    });
    assert(hydrated.kind === 'runCode');
    const run = async (): Promise<unknown> =>
      await hydrated.execute('in', hosts.harness.createContext());
    const said = await refusal(run(), 'CONNECTION_NOT_ALLOWED');
    expect(hosts.machine.calls).toHaveLength(0);
    expect(said).not.toContain('sandbox');
  });

  it("takes the host's resolveSubprocess first, with no grant", async () => {
    const hosts = twoHosts();
    const own = host('own');
    const hydrated = hydrateNode(node, {
      tools: new Map(),
      executeStep: async (_step, input) => frameworkCast(input),
      runCodeBounds: {},
      resolveSubprocess: (ref) => (ref === 'machine' ? own.adapter : undefined),
    });
    assert(hydrated.kind === 'runCode');
    expect(await hydrated.execute('in', hosts.harness.createContext())).toBe('own');
    expect(hosts.machine.calls).toHaveLength(0);
  });
});
