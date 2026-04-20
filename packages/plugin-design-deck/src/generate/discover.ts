import { readFileSync } from 'node:fs';
import type { CallModel, CallModelMessage } from '@noetic/cli';
import type { Deck } from '../types.js';
import { DeckSchema } from '../types.js';
import { extractJson } from './shared.js';

const PROMPT_URL = new URL('../prompts/deck-discover.md', import.meta.url);

export interface DiscoverTurn {
  question: string;
  answer: string;
}

interface NextArgs {
  callModel: CallModel;
  history: ReadonlyArray<DiscoverTurn>;
  model?: string;
}

export type DiscoverResult =
  | {
      kind: 'question';
      question: string;
    }
  | {
      kind: 'deck';
      deck: Deck;
    };

export async function nextDiscoverTurn(args: NextArgs): Promise<DiscoverResult> {
  const systemPrompt = readFileSync(PROMPT_URL, 'utf8');
  const messages: CallModelMessage[] = [
    {
      role: 'system',
      content: systemPrompt,
    },
  ];
  for (const turn of args.history) {
    messages.push({
      role: 'assistant',
      content: turn.question,
    });
    messages.push({
      role: 'user',
      content: turn.answer,
    });
  }
  if (args.history.length === 0) {
    messages.push({
      role: 'user',
      content: 'Begin the interview. Ask your first question.',
    });
  }
  const response = await args.callModel({
    messages,
    model: args.model,
    temperature: 0.5,
  });
  const text = response.text.trim();
  const maybeJson = extractJson(text);
  const asDeck = DeckSchema.safeParse(maybeJson);
  if (asDeck.success) {
    return {
      kind: 'deck',
      deck: asDeck.data,
    };
  }
  return {
    kind: 'question',
    question: text,
  };
}
