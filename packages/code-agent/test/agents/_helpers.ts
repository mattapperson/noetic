/**
 * Shared helpers for act/fix check-step tests.
 *
 * The check steps only touch a small slice of `Context`: the shell adapter
 * via the harness, `rootCwdState.cwd`, `lastStepMeta.toolCalls`, the memory
 * handle for the flow-state layer, `harness.config.params`, and the two
 * harness mutators `setLayerState` + `storeLayers`. The helper constructs a
 * full `Context<ContextMemory>` object literal so the type is honest —
 * every required field is present, and unused harness methods throw with a
 * clear "not impl" message if a step body ever reaches for them.
 */

import type {
  Context,
  ContextHarness,
  ContextMemory,
  FunctionCallItem,
  ItemLog,
  ShellAdapter,
  Step,
  StepRun,
} from '@noetic/core';
import type { CodeAgentFlowState } from '../../src/agents/flow-state.js';
import { CODE_AGENT_FLOW_LAYER_ID } from '../../src/agents/flow-state.js';

//#region Types

export interface MockCheckContextOptions {
  diffShortstat: string;
  flowState?: CodeAgentFlowState;
  toolCalls?: ReadonlyArray<Pick<FunctionCallItem, 'name'>>;
  params?: Record<string, unknown>;
  cwd?: string;
}

export interface MockCheckContextResult {
  ctx: Context<ContextMemory>;
  getFlowState: () => CodeAgentFlowState;
  getStoreCallCount: () => number;
  getShellCalls: () => ReadonlyArray<{
    command: string;
    cwd: string;
  }>;
}

//#endregion

//#region Not-impl helpers

function notImpl(name: string): never {
  throw new Error(`${name}: not implemented in check-step test mock`);
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({
          done: true,
          value: undefined,
        }),
      };
    },
  };
}

//#endregion

//#region Factory

/**
 * Builds a real `Context<ContextMemory>` object literal wired to in-memory
 * stubs. The returned accessors let tests assert on the resulting flow state
 * and on the side effects (shell calls, store-layer flushes).
 */
export function createMockCheckContext(opts: MockCheckContextOptions): MockCheckContextResult {
  const cwd = opts.cwd ?? '/repo';
  const shellCalls: Array<{
    command: string;
    cwd: string;
  }> = [];
  let flowState: CodeAgentFlowState = {
    ...(opts.flowState ?? {}),
  };
  let storeCallCount = 0;

  const toolCalls: FunctionCallItem[] = (opts.toolCalls ?? []).map(
    (call, idx) =>
      ({
        arguments: '{}',
        callId: `call-${idx}`,
        name: call.name,
        type: 'function_call',
      }) satisfies FunctionCallItem,
  );

  const shell: ShellAdapter = {
    async exec(command, options) {
      shellCalls.push({
        command,
        cwd: options?.cwd ?? cwd,
      });
      return {
        stdout: opts.diffShortstat,
        stderr: '',
        exitCode: 0,
      };
    },
  };

  const harness: ContextHarness = {
    config: {
      name: 'check-step-test',
      params: opts.params ?? {},
    },
    fs: {
      readFile: () => notImpl('fs.readFile'),
      readFileText: () => notImpl('fs.readFileText'),
      writeFile: () => notImpl('fs.writeFile'),
      writeFileBytes: () => notImpl('fs.writeFileBytes'),
      appendFile: () => notImpl('fs.appendFile'),
      mkdir: () => notImpl('fs.mkdir'),
      rename: () => notImpl('fs.rename'),
      rm: () => notImpl('fs.rm'),
      access: () => notImpl('fs.access'),
      stat: () => notImpl('fs.stat'),
      lstat: () => notImpl('fs.lstat'),
      readdir: () => notImpl('fs.readdir'),
    },
    shell,
    subprocess: {
      spawn: () => notImpl('subprocess.spawn'),
      get: () => notImpl('subprocess.get'),
      stop: () => notImpl('subprocess.stop'),
      pause: () => notImpl('subprocess.pause'),
      resume: () => notImpl('subprocess.resume'),
      isAlive: () => notImpl('subprocess.isAlive'),
      reattach: () => notImpl('subprocess.reattach'),
      listLive: () => notImpl('subprocess.listLive'),
    },
    rootCwdState: {
      cwd,
    },
    callModel: () => notImpl('harness.callModel'),
    execute: () => notImpl('harness.execute'),
    getAgentResponse: () => notImpl('harness.getAgentResponse'),
    getItemStream: () => emptyAsyncIterable(),
    getTextStream: () => emptyAsyncIterable(),
    getReasoningStream: () => emptyAsyncIterable(),
    getFullStream: () => emptyAsyncIterable(),
    run: () => notImpl('harness.run'),
    detachedSpawn: () => notImpl('harness.detachedSpawn'),
    createContext: () => notImpl('harness.createContext'),
    setRootCwd: () => {},
    getLayerState: () => undefined,
    setLayerState(_executionId, layerId, state) {
      if (layerId !== CODE_AGENT_FLOW_LAYER_ID) {
        return;
      }
      if (!isCodeAgentFlowState(state)) {
        throw new Error('setLayerState received a state shape that is not CodeAgentFlowState');
      }
      flowState = {
        ...state,
      };
    },
    beforeToolCall: () => notImpl('harness.beforeToolCall'),
    afterModelCall: () => notImpl('harness.afterModelCall'),
    runAppendPipeline: () => notImpl('harness.runAppendPipeline'),
    recallLayers: () => notImpl('harness.recallLayers'),
    projectHistory: () => notImpl('harness.projectHistory'),
    async storeLayers() {
      storeCallCount += 1;
    },
    previewRequestItems: () => notImpl('harness.previewRequestItems'),
    send: () => notImpl('harness.send'),
    recv: () => notImpl('harness.recv'),
    tryRecv: () => null,
    getChannelHandle: () => notImpl('harness.getChannelHandle'),
    initLayers: () => notImpl('harness.initLayers'),
    disposeLayers: () => notImpl('harness.disposeLayers'),
    checkpoint: () => notImpl('harness.checkpoint'),
    restore: () => notImpl('harness.restore'),
    cancel: () => notImpl('harness.cancel'),
    createSpan: (name) => ({
      traceId: 'test-trace',
      spanId: name,
      parentSpanId: null,
      setAttribute() {},
      addEvent() {},
      end() {},
    }),
    abort: () => notImpl('harness.abort'),
    getStatus: () => ({
      kind: 'idle',
    }),
    getQueueSize: () => 0,
    seedSessionHistory: () => {},
    executeRerender: () => notImpl('harness.executeRerender'),
  };

  // `readFlowState` dereferences `ctx.memory[LAYER_ID].state` each call, but
  // `writeFlowState` replaces the outer `flowState` variable — keep the
  // handle in sync by rebinding on read via a getter.
  const flowHandle = {};
  Object.defineProperty(flowHandle, 'state', {
    get: () => flowState,
    enumerable: true,
  });

  const memory: ContextMemory = {
    [CODE_AGENT_FLOW_LAYER_ID]: flowHandle,
  };

  const itemLog: ItemLog = {
    items: [],
    append: () => notImpl('itemLog.append'),
  };

  const ctx: Context<ContextMemory> = {
    id: 'test-ctx',
    stepCount: 0,
    tokens: {
      input: 0,
      output: 0,
      total: 0,
    },
    elapsed: 0,
    cost: 0,
    state: {},
    parent: null,
    depth: 0,
    span: {
      traceId: 'test-trace',
      spanId: 'test-span',
      parentSpanId: null,
      setAttribute() {},
      addEvent() {},
      end() {},
    },
    threadId: 'test-thread',
    itemLog,
    lastStepMeta: {
      toolCalls,
    },
    lastLayerUsage: undefined,
    harness,
    fs: harness.fs,
    shell: harness.shell,
    subprocess: harness.subprocess,
    cwdState: {
      cwd,
    },
    layers: undefined,
    memory,
    unifiedTools: undefined,
    itemSchemas: undefined,
    recv: () => notImpl('ctx.recv'),
    send: () => notImpl('ctx.send'),
    tryRecv: () => null,
    checkpoint: async () => {},
    complete: () => notImpl('ctx.complete'),
    completed: false,
    completionValue: undefined,
    aborted: false,
    abortReason: undefined,
    abort: () => notImpl('ctx.abort'),
  };

  return {
    ctx,
    getFlowState: () => flowState,
    getStoreCallCount: () => storeCallCount,
    getShellCalls: () => shellCalls,
  };
}

//#endregion

//#region Type guards

const VALID_MODES: ReadonlySet<string> = new Set([
  'plan',
  'act',
  'verify',
  'fix',
  'done',
]);

function isCodeAgentFlowState(value: unknown): value is CodeAgentFlowState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('mode' in value)) {
    return true;
  }
  const { mode } = value;
  if (mode === undefined) {
    return true;
  }
  return typeof mode === 'string' && VALID_MODES.has(mode);
}

//#endregion

//#region Step narrowing

/**
 * Narrows a `Step` union to its `run` variant and returns its `execute` fn.
 * Throws if the step's `kind` is not `run`. Lets tests invoke a step's body
 * directly without running the full interpreter.
 */
export function asRunExecute<TMemory, I, O>(
  s: Step<TMemory, I, O>,
): StepRun<TMemory, I, O>['execute'] {
  if (s.kind !== 'run') {
    throw new Error(`Expected StepRun, got kind=${s.kind}`);
  }
  return s.execute;
}

//#endregion

//#region Shortstat builder

/**
 * Builds a `git diff --shortstat`-shaped string for a given total line count.
 * Splits total into a roughly balanced insertion / deletion pair; the check
 * steps only care about the sum, so the split doesn't matter semantically.
 */
export function buildShortstat(totalLines: number): string {
  if (totalLines <= 0) {
    return '';
  }
  const insertions = Math.ceil(totalLines / 2);
  const deletions = totalLines - insertions;
  const parts = [
    `${insertions} insertion${insertions === 1 ? '' : 's'}(+)`,
  ];
  if (deletions > 0) {
    parts.push(`${deletions} deletion${deletions === 1 ? '' : 's'}(-)`);
  }
  return ` 1 file changed, ${parts.join(', ')}\n`;
}

//#endregion
