import { readFileSync } from 'node:fs';
import type { CallModel } from '@noetic/cli';
import type { Deck } from '../types.js';
import { DeckSchema } from '../types.js';
import { extractJson } from './shared.js';

const PROMPT_URL = new URL('../prompts/deck.md', import.meta.url);

interface BuildDeckArgs {
  callModel: CallModel;
  topic: string;
  model?: string;
}

export async function buildDeck(args: BuildDeckArgs): Promise<Deck> {
  const systemPrompt = readFileSync(PROMPT_URL, 'utf8');
  const response = await args.callModel({
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: `Topic: ${args.topic}\n\nProduce the deck now.`,
      },
    ],
    model: args.model,
    temperature: 0.7,
  });
  const parsed = DeckSchema.safeParse(extractJson(response.text));
  if (!parsed.success) {
    throw new Error(`Deck generation failed schema check: ${parsed.error.message}`);
  }
  return parsed.data;
}
