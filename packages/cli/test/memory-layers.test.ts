/**
 * Test the enhanced prompt engineering memory layers.
 */

import { describe, expect, test } from 'bun:test';

import { communicationStyleLayer } from '../src/memory/communication-style-layer.js';
import { environmentContextLayer } from '../src/memory/environment-context-layer.js';
import { planningModeLayer } from '../src/memory/planning-mode-layer.js';
import { promptEngineeringLayer } from '../src/memory/prompt-engineering-layer.js';
import { toolGuidanceLayer } from '../src/memory/tool-guidance-layer.js';
import type { AgentConfig } from '../src/types/config.js';

// Mock shell adapter for testing
const mockShell = {
  exec: async (command: string, options: any) => {
    if (command === 'node --version') {
      return { exitCode: 0, stdout: 'v18.19.0', stderr: '' };
    }
    if (command === 'echo $SHELL') {
      return { exitCode: 0, stdout: '/bin/zsh', stderr: '' };
    }
    if (command === 'git rev-parse --is-inside-work-tree') {
      return { exitCode: 0, stdout: 'true', stderr: '' };
    }
    if (command === 'git branch --show-current') {
      return { exitCode: 0, stdout: 'main', stderr: '' };
    }
    if (command.startsWith('command -v')) {
      const cmd = command.split(' ').pop();
      if (['git', 'npm', 'node'].includes(cmd || '')) {
        return { exitCode: 0, stdout: `/usr/bin/${cmd}`, stderr: '' };
      }
    }
    return { exitCode: 1, stdout: '', stderr: 'command not found' };
  },
};

const mockConfig: AgentConfig = {
  model: 'test-model',
  cwd: '/test/project',
  apiKey: 'test-key',
  maxTurns: 10,
};

const mockTools = [
  { name: 'Read', description: 'Read files' },
  { name: 'Edit', description: 'Edit files' },
  { name: 'Write', description: 'Write files' },
  { name: 'Find', description: 'Find files' },
  { name: 'Grep', description: 'Search content' },
];

describe('Enhanced Memory Layers', () => {
  test('promptEngineeringLayer initializes correctly', async () => {
    const layer = promptEngineeringLayer();
    expect(layer.id).toBe('prompt-engineering');
    expect(layer.name).toBe('Prompt Engineering');
    expect(layer.budget.min).toBe(200);
    expect(layer.budget.max).toBe(1000);

    const { state } = await layer.hooks.init!({} as any);
    expect(state.currentMode).toBe('normal');
    expect(state.recentErrors).toEqual([]);
    expect(state.toolUsagePatterns).toBeInstanceOf(Map);
  });

  test('communicationStyleLayer recalls guidelines', async () => {
    const layer = communicationStyleLayer();
    const { state } = await layer.hooks.init!({} as any);
    const content = await layer.hooks.recall!({ state, ctx: {} as any });
    
    expect(content).toContain('Communication Style: Normal');
    expect(content).toContain('Core Formatting Rules');
    expect(content).toContain('file_path:line_number format');
  });

  test('toolGuidanceLayer provides tool hierarchy', async () => {
    const layer = toolGuidanceLayer({ tools: mockTools, mode: 'normal' });
    const { state } = await layer.hooks.init!({} as any);
    const content = await layer.hooks.recall!({ state, ctx: {} as any });
    
    expect(content).toContain('Tool Usage Guidelines');
    expect(content).toContain('Tool Usage Hierarchy');
    expect(content).toContain('Read tool (NOT cat/head/tail)');
    expect(content).toContain('Edit tool (NOT sed/awk)');
  });

  test('environmentContextLayer detects environment', async () => {
    const layer = environmentContextLayer({ 
      config: mockConfig, 
      shell: mockShell as any 
    });
    
    const { state } = await layer.hooks.init!({} as any);
    expect(state.environment.cwd).toBe('/test/project');
    expect(state.environment.isGitRepo).toBe(true);
    expect(state.environment.nodeVersion).toBe('v18.19.0');
    
    const content = await layer.hooks.recall!({ state, ctx: {} as any });
    expect(content).toContain('Environment Context');
    expect(content).toContain('/test/project');
    expect(content).toContain('v18.19.0');
  });

  test('planningModeLayer activates for planning mode', async () => {
    const layer = planningModeLayer({ 
      availableTools: mockTools, 
      currentMode: 'planning' 
    });
    
    const { state } = await layer.hooks.init!({} as any);
    expect(state.isActive).toBe(true);
    expect(state.planningPhase).toBe('exploration');
    
    const content = await layer.hooks.recall!({ state, ctx: {} as any });
    expect(content).toContain('Plan Mode Active');
    expect(content).toContain('FlowSchema Node Types');
    expect(content).toContain('PRD Authoring Best Practices');
  });

  test('planningModeLayer returns null for normal mode', async () => {
    const layer = planningModeLayer({ 
      availableTools: mockTools, 
      currentMode: 'normal' 
    });
    
    const { state } = await layer.hooks.init!({} as any);
    expect(state.isActive).toBe(false);
    
    const content = await layer.hooks.recall!({ state, ctx: {} as any });
    expect(content).toBeNull();
  });

  test('toolGuidanceLayer provides plan mode specific guidance', async () => {
    const layer = toolGuidanceLayer({ tools: mockTools, mode: 'planning' });
    const { state } = await layer.hooks.init!({} as any);
    const content = await layer.hooks.recall!({ state, ctx: {} as any });
    
    expect(content).toContain('Plan Mode Tool Usage');
    expect(content).toContain('FlowSchema Node Types');
    expect(content).toContain('**llm**: Direct LLM processing');
    expect(content).toContain('**subagent**: Delegate to specialized');
  });

  test('communicationStyleLayer adapts based on user messages', async () => {
    const layer = communicationStyleLayer();
    const { state } = await layer.hooks.init!({} as any);
    
    // Simulate user messages requesting direct answers
    const userMessages = [
      { type: 'message', role: 'user', content: 'Just give me the quick answer' },
      { type: 'message', role: 'user', content: 'Brief response please' },
    ];
    
    const result = await layer.hooks.store!({ 
      newItems: userMessages, 
      state, 
      ctx: {} as any 
    });
    
    expect(result?.state.style).toBe('concise');
  });
});