/**
 * Root TUI application — interactive agent loop with terminal rendering.
 */

import type { Interface } from 'node:readline';
import { createInterface } from 'node:readline';
import type { OpenRouter, StreamableOutputItem } from '@openrouter/sdk';
import { stepCountIs } from '@openrouter/sdk';
import { createStreamAdapter, extractTextContent } from '../ai/stream-adapter.js';
import { buildSystemPrompt } from '../ai/system-prompt.js';
import { createCodingTools } from '../tools/index.js';
import type { AgentConfig } from '../types/config.js';

//#region Types

interface ConversationTurn {
  role: 'user';
  content: string;
}

//#endregion

//#region Agent Loop

export async function runAgent(client: OpenRouter, config: AgentConfig): Promise<void> {
  const tools = createCodingTools(config.cwd);
  const systemPrompt = config.systemPrompt ?? buildSystemPrompt(config.cwd);
  const adapter = createStreamAdapter();
  const conversationHistory: Array<ConversationTurn | StreamableOutputItem> = [];

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write('\n\x1b[1m@noetic/agent\x1b[0m — coding assistant\n');
  process.stdout.write(`Model: ${config.model} | cwd: ${config.cwd}\n`);
  process.stdout.write('Type your message. Ctrl+C to exit.\n\n');

  while (true) {
    const userInput = await promptUser(rl);
    if (userInput === null) {
      break;
    }
    if (!userInput.trim()) {
      continue;
    }

    conversationHistory.push({
      role: 'user',
      content: userInput,
    });

    process.stdout.write('\n\x1b[2m⟩ thinking...\x1b[0m');

    const result = client.callModel({
      model: config.model,
      instructions: systemPrompt,
      input: conversationHistory,
      tools,
      stopWhen: [
        stepCountIs(config.maxTurns),
      ],
    });

    adapter.reset();

    for await (const item of result.getItemsStream()) {
      adapter.processItem(item);
      conversationHistory.push(item);
      renderItem(item);
    }

    process.stdout.write('\n');
  }

  rl.close();
  process.stdout.write('\nGoodbye.\n');
}

//#endregion

//#region Rendering

function renderItem(item: StreamableOutputItem): void {
  if (item.type === 'message' && item.status === 'completed') {
    const text = extractTextContent(item);
    if (text) {
      process.stdout.write(`\r\x1b[K\x1b[36m⟩\x1b[0m ${text}\n`);
    }
    return;
  }

  if (item.type === 'function_call') {
    if (item.status === 'in_progress') {
      process.stdout.write(`\r\x1b[K\x1b[33m⟩ [tool: ${item.name}]\x1b[0m`);
    } else if (item.status === 'completed') {
      process.stdout.write(`\r\x1b[K\x1b[32m✓ [tool: ${item.name}]\x1b[0m\n`);
    }
    return;
  }

  if (item.type === 'function_call_output') {
    const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
    const preview = output.length > 200 ? `${output.slice(0, 200)}...` : output;
    process.stdout.write(`\x1b[2m  ${preview}\x1b[0m\n`);
  }
}

//#endregion

//#region Readline Helpers

function promptUser(rl: Interface): Promise<string | null> {
  return new Promise((resolve) => {
    rl.question('\x1b[1m❯\x1b[0m ', (answer) => {
      resolve(answer);
    });
    rl.once('close', () => {
      resolve(null);
    });
  });
}

//#endregion
