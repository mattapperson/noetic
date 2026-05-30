/**
 * Code-agent smoke surface. Imports `@noetic-tools/code-agent`, whose built
 * `dist` statically pulls in `node:url`/LSP modules — so this module only loads
 * on runtimes with Node compatibility (Node, Bun, Deno, Cloudflare Workers).
 * The browser target must NOT import this file.
 *
 * It builds a code agent over the portable in-memory adapters, runs a *live*
 * OpenRouter call through its harness, and exercises the portable Write→Read
 * tool round-trip.
 */

import { createCodeAgent, createCodingToolsPlugin } from '@noetic-tools/code-agent';
import type { ToolExecutionContext, ToolMemory } from '@noetic-tools/core';
import { step } from '@noetic-tools/core';

import { asNonEmptyString, PING_INSTRUCTIONS, PING_PROMPT } from './core-smoke.js';
import type { CodeAgentSmokeResult } from './types.js';

/** A no-op tool memory accessor — the smoke tools do not persist layer state. */
const NOOP_TOOL_MEMORY: ToolMemory = {
  get: () => undefined,
  set: () => undefined,
};

/** The smoke runs tools with no prior assembled view. */
const EMPTY_ASSEMBLED_VIEW: ToolExecutionContext['assembledView'] = [];

/** The Read tool returns a structured object; pull the file text out of it. */
function extractReadContent(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object' && 'content' in result) {
    const { content } = result;
    if (typeof content === 'string') {
      return content;
    }
  }
  return JSON.stringify(result);
}

/** Build a code agent, run a live call, and verify the portable tool round-trip. */
export async function runCodeAgentSmoke(
  apiKey: string,
  model: string,
): Promise<CodeAgentSmokeResult> {
  const agent = await createCodeAgent({
    name: 'compat-code-agent-smoke',
    model,
    cwd: '/compat',
    defaultMemory: false,
    llm: {
      provider: 'openrouter',
      apiKey,
    },
    plugins: [
      createCodingToolsPlugin(),
    ],
  });

  try {
    // 1. Live call through the code-agent harness (it *is* an AgentHarness).
    const llmStep = step.llm({
      id: 'compat-code-agent-ping',
      model,
      instructions: PING_INSTRUCTIONS,
    });
    const liveCtx = agent.createContext();
    const reply = asNonEmptyString(
      await agent.run(llmStep, PING_PROMPT, liveCtx),
      'code-agent step.llm',
    );

    // 2. Portable Write→Read round-trip over the in-memory fs adapter.
    const writeTool = agent.tools.get('Write');
    const readTool = agent.tools.get('Read');
    if (!writeTool || !readTool) {
      throw new Error('Write/Read tools were not registered by createCodingToolsPlugin');
    }

    const toolCtx: ToolExecutionContext = {
      ctx: agent.createContext(),
      harness: agent,
      fs: agent.fs,
      shell: agent.shell,
      memory: NOOP_TOOL_MEMORY,
      assembledView: EMPTY_ASSEMBLED_VIEW,
      lastStepMeta: null,
    };

    const marker = 'PORTABLE-ROUND-TRIP-OK';
    await writeTool.execute(
      {
        path: 'compat-smoke.txt',
        content: marker,
      },
      toolCtx,
    );
    const readResult = await readTool.execute(
      {
        path: 'compat-smoke.txt',
      },
      toolCtx,
    );

    const content = extractReadContent(readResult);
    if (!content.includes(marker)) {
      throw new Error(`fs round-trip mismatch: expected to find "${marker}" in read output`);
    }

    return {
      fileRoundTrip: marker,
      reply,
      toolCount: agent.tools.list().length,
    };
  } finally {
    await agent.dispose();
  }
}
