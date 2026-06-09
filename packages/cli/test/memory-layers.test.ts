/**
 * Test the enhanced prompt engineering memory layers.
 */

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import type {
  BudgetConfig,
  ExecutionContext,
  FunctionCallItem,
  FunctionCallOutputItem,
  InitParams,
  Item,
  ItemLog,
  LLMResponse,
  RecallParams,
  RecallResult,
  ScopedStorage,
  ShellAdapter,
  ShellExecOptions,
  ShellExecResult,
  StoreParams,
  Tool,
} from '@noetic/core';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic/core';
import { z } from 'zod';

import { communicationStyleLayer } from '../src/memory/communication-style-layer.js';
import { environmentContextLayer } from '../src/memory/environment-context-layer.js';
import { planningModeLayer } from '../src/memory/planning-mode-layer.js';
import { promptEngineeringLayer } from '../src/memory/prompt-engineering-layer.js';
import { toolGuidanceLayer } from '../src/memory/tool-guidance-layer.js';
import type { AgentConfig } from '../src/types/config.js';

//#region Typed test helpers

// These layers only read `state` in recall/store and ignore the other hook
// params, so minimal-but-real context objects are sufficient. Built without
// `any`/`as` casts to keep the test suite strict per the testing rules.
function makeStorage(): ScopedStorage {
  // These layers never touch storage during init; a no-op backing is enough.
  return {
    async get() {
      return null;
    },
    async set() {},
    async delete() {},
    async list() {
      return [];
    },
  };
}

function makeCtx(shell: ShellAdapter = createLocalShellAdapter()): ExecutionContext {
  return {
    executionId: 'exec-test',
    threadId: 'thread-test',
    resourceId: 'user-test',
    depth: 0,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    fs: createLocalFsAdapter(),
    shell,
    tokenize: (text: string) => Math.ceil(text.length / 4),
    trace: {
      setAttribute() {},
      addEvent() {},
    },
  };
}

function makeItemLog(): ItemLog {
  const items: Item[] = [];
  return {
    get items() {
      return items;
    },
    append(item: Item) {
      items.push(item);
    },
  };
}

function makeResponse(): LLMResponse {
  return {
    items: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
  };
}

function initParams(): InitParams {
  return {
    storage: makeStorage(),
    scopeKey: 'test',
    ctx: makeCtx(),
  };
}

function recallParams<TState>(
  state: TState,
  budget = 1000,
  ctx: ExecutionContext = makeCtx(),
): RecallParams<TState> {
  return {
    log: makeItemLog(),
    query: '',
    ctx,
    state,
    budget,
  };
}

function storeParams<TState>(state: TState, newItems: Item[]): StoreParams<TState> {
  return {
    newItems,
    log: makeItemLog(),
    response: makeResponse(),
    ctx: makeCtx(),
    state,
  };
}

function makeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    input: z.object({}),
    output: z.object({}),
    async execute() {
      return {};
    },
  };
}

/** Narrow a layer's budget to its `{ min, max }` range form for assertions. */
function budgetRange(budget: BudgetConfig | undefined): {
  min: number;
  max: number;
} {
  if (typeof budget !== 'object') {
    throw new Error('expected a { min, max } budget range');
  }
  return budget;
}

function makeUserMessage(id: string, text: string): Item {
  return {
    id,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

/** Build a model `function_call` item (the shape store hooks count as tool usage). */
function makeFunctionCall(name: string, args = '{}'): FunctionCallItem {
  return {
    id: `fc-${name}-${args.length}`,
    type: 'function_call',
    name,
    callId: `call-${name}`,
    arguments: args,
    status: 'completed',
  };
}

/** Build a `function_call_output` item; `status` drives error detection. */
function makeFunctionCallOutput(
  output: string,
  status: FunctionCallOutputItem['status'] = 'completed',
): FunctionCallOutputItem {
  return {
    id: `fo-${output.length}-${status}`,
    type: 'function_call_output',
    status,
    callId: 'call-out',
    output,
  };
}

/** Narrow a recall result (which may be a `RecallResult`, a string, or null) to a string. */
function asString(value: RecallResult<unknown> | string | null): string {
  assert.equal(typeof value, 'string', 'expected recall to return a string');
  // typeof narrowing above guarantees this branch only runs for strings
  return typeof value === 'string' ? value : '';
}

//#endregion

// Mock shell adapter for testing. Deterministic — no real shell execution.
const mockShell: ShellAdapter = {
  exec: async (command: string, _options: ShellExecOptions): Promise<ShellExecResult> => {
    if (command === 'node --version') {
      return {
        exitCode: 0,
        stdout: 'v18.19.0',
        stderr: '',
      };
    }
    if (command === 'echo $SHELL') {
      return {
        exitCode: 0,
        stdout: '/bin/zsh',
        stderr: '',
      };
    }
    if (command === 'git rev-parse --is-inside-work-tree') {
      return {
        exitCode: 0,
        stdout: 'true',
        stderr: '',
      };
    }
    if (command === 'git branch --show-current') {
      return {
        exitCode: 0,
        stdout: 'main',
        stderr: '',
      };
    }
    if (command.startsWith('command -v')) {
      const cmd = command.split(' ').pop();
      if (
        [
          'git',
          'npm',
          'docker',
          'jq',
        ].includes(cmd || '')
      ) {
        return {
          exitCode: 0,
          stdout: `/usr/bin/${cmd}`,
          stderr: '',
        };
      }
    }
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'command not found',
    };
  },
};

const mockConfig: AgentConfig = {
  model: 'test-model',
  cwd: '/test/project',
  apiKey: 'test-key',
  maxTurns: 10,
};

// A config whose cwd is a real directory containing a package.json, so the
// fs-based package-manager detection resolves and the "Package Management"
// section is present (required for the budget-trimming section indices to
// line up — see the budget-trimming test below).
const realCwdConfig: AgentConfig = {
  model: 'test-model',
  cwd: process.cwd(),
  apiKey: 'test-key',
  maxTurns: 10,
};

const mockTools: Tool[] = [
  makeTool('Read', 'Read files'),
  makeTool('Edit', 'Edit files'),
  makeTool('Write', 'Write files'),
  makeTool('Find', 'Find files'),
  makeTool('Grep', 'Search content'),
];

describe('Enhanced Memory Layers', () => {
  test('promptEngineeringLayer initializes correctly', async () => {
    const layer = promptEngineeringLayer();
    expect(layer.id).toBe('prompt-engineering');
    expect(layer.name).toBe('Prompt Engineering');
    const budget = budgetRange(layer.budget);
    expect(budget.min).toBe(200);
    expect(budget.max).toBe(1000);

    const init = await layer.hooks.init!(initParams());
    assert(init);
    const { state } = init;
    expect(state.currentMode).toBe('normal');
    expect(state.recentErrors).toEqual([]);
    // toolUsagePatterns is now a plain Record, not a Map.
    expect(state.toolUsagePatterns).toEqual({});
  });

  test('communicationStyleLayer recalls guidelines', async () => {
    const layer = communicationStyleLayer();
    const init = await layer.hooks.init!(initParams());
    assert(init);
    const content = asString(await layer.hooks.recall!(recallParams(init.state)));

    // The communication-style layer is the sole owner of these substrings
    // after the dedup refactor.
    expect(content).toContain('Communication Style: Normal');
    expect(content).toContain('Core Formatting Rules');
    expect(content).toContain('file_path:line_number format');
  });

  test('toolGuidanceLayer provides tool hierarchy', async () => {
    const layer = toolGuidanceLayer({
      tools: mockTools,
      mode: 'normal',
    });
    const init = await layer.hooks.init!(initParams());
    assert(init);
    const content = asString(await layer.hooks.recall!(recallParams(init.state)));

    // tool-guidance is the owner of the hierarchy block post-dedup.
    expect(content).toContain('Tool Usage Guidelines');
    expect(content).toContain('Tool Usage Hierarchy');
    expect(content).toContain('Read tool (NOT cat/head/tail)');
    expect(content).toContain('Edit tool (NOT sed/awk)');
  });

  test('environmentContextLayer detects environment lazily on first recall', async () => {
    const layer = environmentContextLayer({
      config: mockConfig,
      shell: mockShell,
    });

    // init() is lazy: no detection yet.
    const init = await layer.hooks.init!(initParams());
    assert(init);
    const { state } = init;
    expect(state.environment).toBeNull();

    // First recall triggers detection and mutates `state` with shell-derived
    // fields. cwd '/test/project' does not exist on disk, so fs-derived
    // packageManager is not asserted here.
    const content = asString(await layer.hooks.recall!(recallParams(state)));

    assert(state.environment);
    expect(state.environment.cwd).toBe('/test/project');
    expect(state.environment.isGitRepo).toBe(true);
    expect(state.environment.gitBranch).toBe('main');
    expect(state.environment.nodeVersion).toBe('v18.19.0');
    expect(state.environment.shellType).toBe('zsh');

    expect(content).toContain('Environment Context');
    expect(content).toContain('/test/project');
    expect(content).toContain('v18.19.0');
    expect(content).toContain('main');
  });

  test('planningModeLayer activates for planning mode', async () => {
    const layer = planningModeLayer({
      availableTools: mockTools,
      currentMode: 'planning',
    });

    const init = await layer.hooks.init!(initParams());
    assert(init);
    const { state } = init;
    expect(state.isActive).toBe(true);
    expect(state.planningPhase).toBe('exploration');

    const content = asString(await layer.hooks.recall!(recallParams(state)));
    expect(content).toContain('Plan Mode Active');
    expect(content).toContain('FlowSchema Node Types');
    expect(content).toContain('PRD Authoring Best Practices');
  });

  test('planningModeLayer returns null for normal mode', async () => {
    const layer = planningModeLayer({
      availableTools: mockTools,
      currentMode: 'normal',
    });

    const init = await layer.hooks.init!(initParams());
    assert(init);
    const { state } = init;
    expect(state.isActive).toBe(false);

    const content = await layer.hooks.recall!(recallParams(state));
    expect(content).toBeNull();
  });

  test('toolGuidanceLayer provides plan mode specific guidance', async () => {
    const layer = toolGuidanceLayer({
      tools: mockTools,
      mode: 'planning',
    });
    const init = await layer.hooks.init!(initParams());
    assert(init);
    const content = asString(await layer.hooks.recall!(recallParams(init.state)));

    expect(content).toContain('Plan Mode Tool Usage');
    expect(content).toContain('FlowSchema Node Types');
    expect(content).toContain('**llm**: Direct LLM processing');
    expect(content).toContain('**subagent**: Delegate to specialized');
  });

  test('communicationStyleLayer adapts based on user messages', async () => {
    const layer = communicationStyleLayer();
    const init = await layer.hooks.init!(initParams());
    assert(init);

    // Simulate user messages requesting direct answers (short + direct).
    const userMessages: Item[] = [
      makeUserMessage('msg-1', 'Just give me the quick answer'),
      makeUserMessage('msg-2', 'Brief response please'),
    ];

    const result = await layer.hooks.store!(storeParams(init.state, userMessages));
    assert(result);
    expect(result.state.style).toBe('concise');
  });
});

//#region communication-style-layer adaptation coverage

describe('communicationStyleLayer adaptation', () => {
  async function freshState() {
    const layer = communicationStyleLayer();
    const init = await layer.hooks.init!(initParams());
    assert(init);
    return {
      layer,
      state: init.state,
    };
  }

  test('concise path: direct requests dominate and average length < 50', async () => {
    const { layer, state } = await freshState();
    const result = await layer.hooks.store!(
      storeParams(state, [
        makeUserMessage('m1', 'just quick'),
        makeUserMessage('m2', 'brief short'),
      ]),
    );
    assert(result);
    expect(result.state.style).toBe('concise');
    // Mutation observable: direct-answer preference flips on.
    expect(result.state.userPreferences.prefersDirectAnswers).toBe(true);
    expect(result.state.userPreferences.prefersExplanations).toBe(false);
  });

  test('verbose path: explanation requests dominate over direct requests', async () => {
    const { layer, state } = await freshState();
    const result = await layer.hooks.store!(
      storeParams(state, [
        makeUserMessage('m1', 'please explain why this works'),
        makeUserMessage('m2', 'help me understand the flow'),
      ]),
    );
    assert(result);
    expect(result.state.style).toBe('verbose');
    expect(result.state.userPreferences.prefersExplanations).toBe(true);
  });

  test('verbose path: technical questions exceed half of recent analyses', async () => {
    const { layer, state } = await freshState();
    // Both messages are technical (function/api keywords) and neither is a
    // direct/explanation request, so technicalQuestions > length/2 wins.
    const result = await layer.hooks.store!(
      storeParams(state, [
        makeUserMessage('m1', 'the function returns a value'),
        makeUserMessage('m2', 'this api accepts a payload'),
      ]),
    );
    assert(result);
    expect(result.state.style).toBe('verbose');
    expect(result.state.userPreferences.asksTechnicalQuestions).toBe(true);
  });

  test('normal path: direct phrasing but average length >= 50 stays normal', async () => {
    const { layer, state } = await freshState();
    const result = await layer.hooks.store!(
      storeParams(state, [
        makeUserMessage(
          'm1',
          'just give me a really long message that exceeds fifty characters total here ok',
        ),
      ]),
    );
    assert(result);
    expect(result.state.style).toBe('normal');
    expect(result.state.conversationMetrics.averageUserMessageLength).toBeGreaterThanOrEqual(50);
  });

  test('updateUserPreferences explanation threshold boundary (0.3 ratio over 10 msgs)', async () => {
    // Threshold: explanationCount > analyses.length * 0.3 => count > 3 over 10.
    // Boundary trio: 3 (false), 4 (true), 5 (true).
    const makeBatch = (explanationCount: number): Item[] => {
      const items: Item[] = [];
      for (let i = 0; i < 10; i++) {
        items.push(makeUserMessage(`m${i}`, i < explanationCount ? 'please explain' : 'ok'));
      }
      return items;
    };

    const expectations: Array<{
      count: number;
      prefers: boolean;
    }> = [
      {
        count: 3,
        prefers: false,
      },
      {
        count: 4,
        prefers: true,
      },
      {
        count: 5,
        prefers: true,
      },
    ];

    for (const { count, prefers } of expectations) {
      const { layer, state } = await freshState();
      const result = await layer.hooks.store!(storeParams(state, makeBatch(count)));
      assert(result);
      expect(result.state.userPreferences.prefersExplanations).toBe(prefers);
    }
  });

  test('updateUserPreferences technical threshold boundary (0.4 ratio over 10 msgs)', async () => {
    // Threshold: technicalCount > analyses.length * 0.4 => count > 4 over 10.
    // Boundary trio: 4 (false), 5 (true), 6 (true).
    const makeBatch = (technicalCount: number): Item[] => {
      const items: Item[] = [];
      for (let i = 0; i < 10; i++) {
        items.push(makeUserMessage(`m${i}`, i < technicalCount ? 'the function code' : 'ok'));
      }
      return items;
    };

    const expectations: Array<{
      count: number;
      asks: boolean;
    }> = [
      {
        count: 4,
        asks: false,
      },
      {
        count: 5,
        asks: true,
      },
      {
        count: 6,
        asks: true,
      },
    ];

    for (const { count, asks } of expectations) {
      const { layer, state } = await freshState();
      const result = await layer.hooks.store!(storeParams(state, makeBatch(count)));
      assert(result);
      expect(result.state.userPreferences.asksTechnicalQuestions).toBe(asks);
    }
  });

  test('store with no user messages leaves state unchanged', async () => {
    const { layer, state } = await freshState();
    const result = await layer.hooks.store!(
      storeParams(state, [
        makeFunctionCall('Read'),
        makeFunctionCallOutput('ok'),
      ]),
    );
    assert(result);
    expect(result.state.style).toBe('normal');
    expect(result.state.conversationMetrics.totalUserMessages).toBe(0);
  });

  test('recall reflects an adapted concise style', async () => {
    const { layer, state } = await freshState();
    const stored = await layer.hooks.store!(
      storeParams(state, [
        makeUserMessage('m1', 'just quick'),
        makeUserMessage('m2', 'brief short'),
      ]),
    );
    assert(stored);
    const content = asString(await layer.hooks.recall!(recallParams(stored.state)));
    expect(content).toContain('Communication Style: Concise');
    expect(content).toContain('Concise Mode Guidelines');
  });
});

//#endregion

//#region prompt-engineering-layer store coverage

describe('promptEngineeringLayer store', () => {
  async function freshState() {
    const layer = promptEngineeringLayer();
    const init = await layer.hooks.init!(initParams());
    assert(init);
    return {
      layer,
      state: init.state,
    };
  }

  test('increments toolUsagePatterns record per function_call', async () => {
    const { layer, state } = await freshState();
    const result = await layer.hooks.store!(
      storeParams(state, [
        makeFunctionCall('Read'),
        makeFunctionCall('Read'),
        makeFunctionCall('Edit'),
      ]),
    );
    assert(result);
    expect(result.state.toolUsagePatterns).toEqual({
      Read: 2,
      Edit: 1,
    });
  });

  test('toolUsagePatterns accumulate across multiple store calls', async () => {
    const { layer, state } = await freshState();
    const first = await layer.hooks.store!(
      storeParams(state, [
        makeFunctionCall('Grep'),
      ]),
    );
    assert(first);
    const second = await layer.hooks.store!(
      storeParams(first.state, [
        makeFunctionCall('Grep'),
        makeFunctionCall('Bash'),
      ]),
    );
    assert(second);
    expect(second.state.toolUsagePatterns).toEqual({
      Grep: 2,
      Bash: 1,
    });
  });

  test('detectErrors records a failed function_call_output following a call', async () => {
    const { layer, state } = await freshState();
    const result = await layer.hooks.store!(
      storeParams(state, [
        makeFunctionCall('Bash'),
        makeFunctionCallOutput('permission denied', 'failed'),
      ]),
    );
    assert(result);
    expect(result.state.recentErrors).toHaveLength(1);
    const recorded = result.state.recentErrors[0];
    assert(recorded);
    expect(recorded.tool).toBe('Bash');
    expect(recorded.error).toBe('permission denied');
  });

  test('detectErrors does NOT flag a successful output containing the word "error"', async () => {
    // Negative test for the old substring-sniffing false positive: a completed
    // output that merely contains "error" must not be recorded.
    const { layer, state } = await freshState();
    const result = await layer.hooks.store!(
      storeParams(state, [
        makeFunctionCall('Grep'),
        makeFunctionCallOutput('no error found in the codebase', 'completed'),
      ]),
    );
    assert(result);
    expect(result.state.recentErrors).toHaveLength(0);
  });

  test('recentErrors are capped at the last 10', async () => {
    const { layer } = await freshState();
    // Seed state with 10 pre-existing errors, then add 3 more failures.
    const seededInit = await layer.hooks.init!(initParams());
    assert(seededInit);
    const seeded = {
      ...seededInit.state,
      recentErrors: Array.from(
        {
          length: 10,
        },
        (_, i) => ({
          tool: `Old${i}`,
          error: `old error ${i}`,
          timestamp: Date.now(),
        }),
      ),
    };

    const newItems: Item[] = [];
    for (let i = 0; i < 3; i++) {
      newItems.push(makeFunctionCall(`New${i}`));
      newItems.push(makeFunctionCallOutput(`new failure ${i}`, 'failed'));
    }

    const result = await layer.hooks.store!(storeParams(seeded, newItems));
    assert(result);
    expect(result.state.recentErrors).toHaveLength(10);
    // The three newest failures must survive; the three oldest are dropped.
    const tools = result.state.recentErrors.map((e) => e.tool);
    expect(tools).toContain('New2');
    expect(tools).not.toContain('Old0');
    expect(tools).not.toContain('Old2');
  });

  test('recall surfaces tool usage patterns once tools have been used', async () => {
    const { layer, state } = await freshState();
    const stored = await layer.hooks.store!(
      storeParams(state, [
        makeFunctionCall('Read'),
        makeFunctionCall('Read'),
      ]),
    );
    assert(stored);
    const content = asString(await layer.hooks.recall!(recallParams(stored.state)));
    expect(content).toContain('Core Behavioral Guidelines');
    expect(content).toContain('Recent Tool Usage Patterns');
    expect(content).toContain('Read');
  });
});

//#endregion

//#region planning-mode-layer store coverage

describe('planningModeLayer store', () => {
  function makePlanningLayer() {
    return planningModeLayer({
      availableTools: mockTools,
      currentMode: 'planning',
    });
  }

  async function activeState() {
    const layer = makePlanningLayer();
    const init = await layer.hooks.init!(initParams());
    assert(init);
    return {
      layer,
      state: init.state,
    };
  }

  test('exploration stays at 10 Read calls and advances to authoring at 11 (boundary)', async () => {
    const { layer, state } = await activeState();

    const tenReads = Array.from(
      {
        length: 10,
      },
      (_, i) => makeFunctionCall('Read', `{"i":${i}}`),
    );
    const atTen = await layer.hooks.store!(storeParams(state, tenReads));
    assert(atTen);
    expect(atTen.state.explorationProgress.filesExamined).toBe(10);
    expect(atTen.state.planningPhase).toBe('exploration');

    const eleventh = await layer.hooks.store!(
      storeParams(atTen.state, [
        makeFunctionCall('Read', '{"i":10}'),
      ]),
    );
    assert(eleventh);
    expect(eleventh.state.explorationProgress.filesExamined).toBe(11);
    expect(eleventh.state.planningPhase).toBe('authoring');
  });

  test('plan/updatePrd populates activePRDs and advances authoring -> review', async () => {
    const { layer, state } = await activeState();

    // Force into authoring first via 11 reads.
    const reads = Array.from(
      {
        length: 11,
      },
      (_, i) => makeFunctionCall('Read', `{"i":${i}}`),
    );
    const authoring = await layer.hooks.store!(storeParams(state, reads));
    assert(authoring);
    expect(authoring.state.planningPhase).toBe('authoring');

    const reviewed = await layer.hooks.store!(
      storeParams(authoring.state, [
        makeFunctionCall(
          'plan/updatePrd',
          JSON.stringify({
            name: 'feature.md',
          }),
        ),
      ]),
    );
    assert(reviewed);
    expect(reviewed.state.activePRDs).toContain('feature.md');
    expect(reviewed.state.planningPhase).toBe('review');
  });

  test('plan/updatePrd with unparseable arguments falls back to a placeholder PRD', async () => {
    const { layer, state } = await activeState();
    const result = await layer.hooks.store!(
      storeParams(state, [
        makeFunctionCall('plan/updatePrd', 'not-json'),
      ]),
    );
    assert(result);
    expect(result.state.activePRDs).toContain('plan.md');
  });

  test('plan/setPlanTree records a FlowSchema execution-tree node', async () => {
    const { layer, state } = await activeState();
    const result = await layer.hooks.store!(
      storeParams(state, [
        makeFunctionCall('plan/setPlanTree'),
      ]),
    );
    assert(result);
    expect(result.state.flowSchemaNodes).toHaveLength(1);
    const node = result.state.flowSchemaNodes[0];
    assert(node);
    expect(node.type).toBe('execution-tree');
  });

  test('store is a no-op when planning mode is inactive', async () => {
    const layer = planningModeLayer({
      availableTools: mockTools,
      currentMode: 'normal',
    });
    const init = await layer.hooks.init!(initParams());
    assert(init);
    const result = await layer.hooks.store!(
      storeParams(init.state, [
        makeFunctionCall('Read'),
        makeFunctionCall('Read'),
      ]),
    );
    assert(result);
    expect(result.state.explorationProgress.filesExamined).toBe(0);
    expect(result.state.planningPhase).toBe('exploration');
  });

  test('recall returns content reflecting the current exploration phase', async () => {
    const { layer, state } = await activeState();
    const content = asString(await layer.hooks.recall!(recallParams(state)));
    expect(content).toContain('Current Phase: Exploration');
  });
});

//#endregion

//#region tool-guidance-layer coverage

describe('toolGuidanceLayer hierarchy', () => {
  test('emits a preference line for each recognized available tool', async () => {
    const layer = toolGuidanceLayer({
      tools: mockTools,
      mode: 'normal',
    });
    const init = await layer.hooks.init!(initParams());
    assert(init);
    const content = asString(await layer.hooks.recall!(recallParams(init.state)));

    expect(content).toContain('Read tool (NOT cat/head/tail)');
    expect(content).toContain('Edit tool (NOT sed/awk)');
    expect(content).toContain('Write tool (NOT echo >/cat <<EOF)');
    expect(content).toContain('Find tool (NOT find command)');
    expect(content).toContain('Grep tool (NOT grep/rg)');
  });

  test('returns null when no recognized tools are available', async () => {
    const layer = toolGuidanceLayer({
      tools: [
        makeTool('FooBar', 'unrecognized tool'),
      ],
    });
    const init = await layer.hooks.init!(initParams());
    assert(init);
    const content = await layer.hooks.recall!(recallParams(init.state));
    expect(content).toBeNull();
  });

  test('returns null when the tool list is empty', async () => {
    const layer = toolGuidanceLayer({
      tools: [],
    });
    const init = await layer.hooks.init!(initParams());
    assert(init);
    const content = await layer.hooks.recall!(recallParams(init.state));
    expect(content).toBeNull();
  });

  test('planning mode adds the Plan Mode Tool Usage section', async () => {
    const planning = toolGuidanceLayer({
      tools: mockTools,
      mode: 'planning',
    });
    const planningInit = await planning.hooks.init!(initParams());
    assert(planningInit);
    const planningContent = asString(
      await planning.hooks.recall!(recallParams(planningInit.state)),
    );
    expect(planningContent).toContain('Plan Mode Tool Usage');

    // Normal mode must NOT include the plan-mode section.
    const normal = toolGuidanceLayer({
      tools: mockTools,
      mode: 'normal',
    });
    const normalInit = await normal.hooks.init!(initParams());
    assert(normalInit);
    const normalContent = asString(await normal.hooks.recall!(recallParams(normalInit.state)));
    expect(normalContent).not.toContain('Plan Mode Tool Usage');
  });
});

//#endregion

//#region environment-context-layer budget trimming

describe('environmentContextLayer budget trimming', () => {
  test('drops the Available Commands section under a tiny budget but keeps core sections', async () => {
    const layer = environmentContextLayer({
      config: realCwdConfig,
      shell: mockShell,
    });
    const init = await layer.hooks.init!(initParams());
    assert(init);
    const { state } = init;

    // ctx with the small tokenize used elsewhere; budget far below full output.
    const tiny = asString(await layer.hooks.recall!(recallParams(state, 50)));

    expect(tiny).toContain('## Working Environment');
    expect(tiny).toContain('## Package Management');
    expect(tiny).not.toContain('## Available Commands');
  });

  test('keeps the Available Commands section under a large budget', async () => {
    const layer = environmentContextLayer({
      config: realCwdConfig,
      shell: mockShell,
    });
    const init = await layer.hooks.init!(initParams());
    assert(init);
    const { state } = init;

    const full = asString(await layer.hooks.recall!(recallParams(state, 2000)));

    expect(full).toContain('## Working Environment');
    expect(full).toContain('## Available Commands');
    expect(full).toContain('## Platform Notes');
  });
});

//#endregion
