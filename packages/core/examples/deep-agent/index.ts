/**
 * Deep Agent — DeepAgentsJS recreation using Noetic primitives.
 *
 * Proves that middleware stacks decompose into tools + memory layers + spawn.
 * Run: OPENROUTER_API_KEY=xxx bun run examples/deep-agent/index.ts
 */

import { observationalMemory } from '../../src/memory/layers/observational-memory';
import { staticContent } from '../../src/memory/layers/static-content';
import { toolMemoryLayer } from '../../src/memory/layers/tool-memory-layer';
import { react } from '../../src/patterns/react';
import type { MemoryLayer } from '../../src/types/memory';
import type { StepLoop, StepSpawn } from '../../src/types/step';
import { createExampleRuntime } from '../create-example-runtime';
import type { SubAgentResolver } from '../delegate-tools';
import { createConfigurableDelegateTool } from '../delegate-tools';
import { skillsLayer } from './memory/skills-layer';
import { createFilesystemTools } from './tools/filesystem';
import { createTodoTools } from './tools/todo';
import type { DeepAgentConfig } from './types';

//#region Helper Functions

function defaultResolver(model: string): SubAgentResolver {
  return (task) => ({
    id: `sub-agent-${crypto.randomUUID().slice(0, 8)}`,
    model,
    system: `You are a sub-agent. Complete this task concisely: ${task}`,
  });
}

//#endregion

//#region Public API

export function buildDeepAgent(
  config: DeepAgentConfig,
): StepLoop<string, string> | StepSpawn<string, string> {
  const fsTools = createFilesystemTools(config.rootDir);
  const todoTools = createTodoTools();
  const delegateTool = createConfigurableDelegateTool(
    config.subAgentResolver ?? defaultResolver(config.model),
  );
  const allTools = [
    ...fsTools,
    ...todoTools,
    delegateTool,
  ];

  const layers: MemoryLayer[] = [
    ...(config.instructionFiles?.length
      ? [
          staticContent({
            load: async () => {
              const results = await Promise.allSettled(
                (config.instructionFiles ?? []).map((p) => Bun.file(p).text()),
              );
              return results
                .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
                .map((r) => r.value)
                .join('\n\n---\n\n');
            },
            tag: 'instructions',
          }),
        ]
      : []),
    ...toolMemoryLayer(allTools),
    ...(config.skills?.length
      ? [
          skillsLayer(config.skills),
        ]
      : []),
    observationalMemory({
      bufferThreshold: 4_000,
      observer: async (buffer) => [
        `Summary: processed ${buffer.length} exchanges covering: ${buffer.map((b) => b.slice(0, 50)).join('; ')}`,
      ],
    }),
  ];

  return react({
    model: config.model,
    system: config.system,
    tools: allTools,
    maxSteps: config.maxSteps ?? 25,
    maxCost: config.maxCost,
    memory: layers,
  });
}

export async function runDeepAgent(config: DeepAgentConfig, input: string): Promise<string> {
  const runtime = createExampleRuntime();
  const agent = buildDeepAgent(config);
  const ctx = runtime.createContext();
  return runtime.execute(agent, input, ctx);
}

//#endregion
