/**
 * Test the enhanced prompt engineering memory layers.
 */

import { describe, expect, test } from 'bun:test';
import type {
  BudgetConfig,
  ExecutionContext,
  InitParams,
  Item,
  ItemLog,
  LLMResponse,
  RecallParams,
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

function makeCtx(): ExecutionContext {
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
    shell: createLocalShellAdapter(),
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

function recallParams<TState>(state: TState): RecallParams<TState> {
  return {
    log: makeItemLog(),
    query: '',
    ctx: makeCtx(),
    state,
    budget: 1000,
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

//#endregion

// Mock shell adapter for testing
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
          'node',
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

    const { state } = await layer.hooks.init!(initParams());
    expect(state.currentMode).toBe('normal');
    expect(state.recentErrors).toEqual([]);
    expect(state.toolUsagePatterns).toBeInstanceOf(Map);
  });

  test('communicationStyleLayer recalls guidelines', async () => {
    const layer = communicationStyleLayer();
    const { state } = await layer.hooks.init!(initParams());
    const content = await layer.hooks.recall!(recallParams(state));

    expect(content).toContain('Communication Style: Normal');
    expect(content).toContain('Core Formatting Rules');
    expect(content).toContain('file_path:line_number format');
  });

  test('toolGuidanceLayer provides tool hierarchy', async () => {
    const layer = toolGuidanceLayer({
      tools: mockTools,
      mode: 'normal',
    });
    const { state } = await layer.hooks.init!(initParams());
    const content = await layer.hooks.recall!(recallParams(state));

    expect(content).toContain('Tool Usage Guidelines');
    expect(content).toContain('Tool Usage Hierarchy');
    expect(content).toContain('Read tool (NOT cat/head/tail)');
    expect(content).toContain('Edit tool (NOT sed/awk)');
  });

  test('environmentContextLayer detects environment', async () => {
    const layer = environmentContextLayer({
      config: mockConfig,
      shell: mockShell,
    });

    const { state } = await layer.hooks.init!(initParams());
    expect(state.environment.cwd).toBe('/test/project');
    expect(state.environment.isGitRepo).toBe(true);
    expect(state.environment.nodeVersion).toBe('v18.19.0');

    const content = await layer.hooks.recall!(recallParams(state));
    expect(content).toContain('Environment Context');
    expect(content).toContain('/test/project');
    expect(content).toContain('v18.19.0');
  });

  test('planningModeLayer activates for planning mode', async () => {
    const layer = planningModeLayer({
      availableTools: mockTools,
      currentMode: 'planning',
    });

    const { state } = await layer.hooks.init!(initParams());
    expect(state.isActive).toBe(true);
    expect(state.planningPhase).toBe('exploration');

    const content = await layer.hooks.recall!(recallParams(state));
    expect(content).toContain('Plan Mode Active');
    expect(content).toContain('FlowSchema Node Types');
    expect(content).toContain('PRD Authoring Best Practices');
  });

  test('planningModeLayer returns null for normal mode', async () => {
    const layer = planningModeLayer({
      availableTools: mockTools,
      currentMode: 'normal',
    });

    const { state } = await layer.hooks.init!(initParams());
    expect(state.isActive).toBe(false);

    const content = await layer.hooks.recall!(recallParams(state));
    expect(content).toBeNull();
  });

  test('toolGuidanceLayer provides plan mode specific guidance', async () => {
    const layer = toolGuidanceLayer({
      tools: mockTools,
      mode: 'planning',
    });
    const { state } = await layer.hooks.init!(initParams());
    const content = await layer.hooks.recall!(recallParams(state));

    expect(content).toContain('Plan Mode Tool Usage');
    expect(content).toContain('FlowSchema Node Types');
    expect(content).toContain('**llm**: Direct LLM processing');
    expect(content).toContain('**subagent**: Delegate to specialized');
  });

  test('communicationStyleLayer adapts based on user messages', async () => {
    const layer = communicationStyleLayer();
    const { state } = await layer.hooks.init!(initParams());

    // Simulate user messages requesting direct answers
    const userMessages: Item[] = [
      makeUserMessage('msg-1', 'Just give me the quick answer'),
      makeUserMessage('msg-2', 'Brief response please'),
    ];

    const result = await layer.hooks.store!(storeParams(state, userMessages));

    expect(result?.state.style).toBe('concise');
  });
});
