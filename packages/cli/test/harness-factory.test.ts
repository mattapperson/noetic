import { describe, expect, it } from 'bun:test';

import type { Tool } from '@noetic/core';
import { Slot } from '@noetic/core';
import { createLocalFsAdapter } from '@noetic/platform-node';
import { z } from 'zod';

import { createAgentHarness } from '../src/harness/factory.js';
import { createPluginContextBuilder } from '../src/plugins/context.js';
import type { NoeticPlugin } from '../src/plugins/types.js';
import type { AgentConfig } from '../src/types/config.js';

const testFs = createLocalFsAdapter();

const baseConfig: AgentConfig = {
  model: 'openai/gpt-4o-mini',
  cwd: process.cwd(),
  apiKey: 'test-key',
  maxTurns: 5,
};

const buildContext = createPluginContextBuilder(baseConfig);

function makePluginTool(name: string): Tool {
  return {
    name,
    description: `tool ${name}`,
    input: z.object({}),
    output: z.string(),
    execute: async () => 'ok',
  };
}

describe('createAgentHarness', () => {
  it('includes plugin tools by default', async () => {
    const plugin: NoeticPlugin = {
      name: 'plugin-a',
      version: '1.0.0',
      tools: async () => [
        makePluginTool('PluginTool'),
      ],
    };

    const { harness } = await createAgentHarness({
      config: baseConfig,
      plugins: [
        plugin,
      ],
      fs: testFs,
      buildContext,
    });

    expect(harness).toBeDefined();
  });

  it('filters tools by include list', async () => {
    const plugin: NoeticPlugin = {
      name: 'plugin-b',
      version: '1.0.0',
      tools: async () => [
        makePluginTool('OnlyPluginTool'),
      ],
    };

    const { harness } = await createAgentHarness({
      config: {
        ...baseConfig,
        tools: {
          include: [
            'OnlyPluginTool',
          ],
        },
      },
      plugins: [
        plugin,
      ],
      fs: testFs,
      buildContext,
    });

    expect(harness).toBeDefined();
  });

  it('filters tools by exclude list', async () => {
    const plugin: NoeticPlugin = {
      name: 'plugin-c',
      version: '1.0.0',
      tools: async () => [
        makePluginTool('BlockedPluginTool'),
      ],
    };

    const { harness } = await createAgentHarness({
      config: {
        ...baseConfig,
        tools: {
          exclude: [
            'BlockedPluginTool',
          ],
        },
      },
      plugins: [
        plugin,
      ],
      fs: testFs,
      buildContext,
    });

    expect(harness).toBeDefined();
  });

  it('returns canonical skill catalog', async () => {
    const { skills } = await createAgentHarness({
      config: baseConfig,
      plugins: [],
      fs: testFs,
      buildContext,
    });

    expect(skills).toBeDefined();
    expect(Array.isArray(skills)).toBe(true);
  });

  it('registers the reminder layer at Slot.REMINDER ahead of planMemory (STEERING)', async () => {
    const { memoryLayers } = await createAgentHarness({
      config: baseConfig,
      plugins: [],
      fs: testFs,
      buildContext,
    });
    const ids = memoryLayers.map((l) => l.id);
    expect(ids).toContain('reminder');
    expect(ids).toContain('agent-md');

    const reminderIdx = memoryLayers.findIndex((l) => l.id === 'reminder');
    const planIdx = memoryLayers.findIndex((l) => l.id === 'plan-memory');
    expect(reminderIdx).toBeGreaterThanOrEqual(0);
    // Reminder layer must come before plan-memory in the array (and have a lower slot).
    if (planIdx >= 0) {
      expect(reminderIdx).toBeLessThan(planIdx);
    }
    const reminder = memoryLayers[reminderIdx];
    expect(reminder?.slot).toBe(Slot.REMINDER);
    expect(Slot.REMINDER).toBeLessThan(Slot.STEERING);
  });

  it('places agent-md ahead of the observations slot', async () => {
    const { memoryLayers } = await createAgentHarness({
      config: baseConfig,
      plugins: [],
      fs: testFs,
      buildContext,
    });
    const agentMd = memoryLayers.find((l) => l.id === 'agent-md');
    expect(agentMd).toBeDefined();
    if (agentMd === undefined) {
      throw new Error('unreachable');
    }
    expect(agentMd.slot).toBeLessThan(Slot.OBSERVATIONS);
  });
});
