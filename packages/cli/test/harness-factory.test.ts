import { describe, expect, it } from 'bun:test';

import type { Tool } from '@noetic/core';
import { z } from 'zod';

import { createAgentHarness } from '../src/harness/factory.js';
import type { NoeticPlugin } from '../src/plugins/types.js';
import type { AgentConfig } from '../src/types/config.js';

const baseConfig: AgentConfig = {
  model: 'openai/gpt-4o-mini',
  cwd: process.cwd(),
  apiKey: 'test-key',
  maxTurns: 5,
};

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

    const harness = await createAgentHarness(baseConfig, [
      plugin,
    ]);

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

    const harness = await createAgentHarness(
      {
        ...baseConfig,
        tools: {
          include: [
            'OnlyPluginTool',
          ],
        },
      },
      [
        plugin,
      ],
    );

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

    const harness = await createAgentHarness(
      {
        ...baseConfig,
        tools: {
          exclude: [
            'BlockedPluginTool',
          ],
        },
      },
      [
        plugin,
      ],
    );

    expect(harness).toBeDefined();
  });
});
