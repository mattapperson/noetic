import { readFileSync } from 'node:fs';
import type { CallModel } from '@noetic-tools/cli';
import { z } from 'zod';
import type { DeckOption, Slide } from '../types.js';
import { OptionSchema } from '../types.js';
import { extractJson } from './shared.js';

const PROMPT_URL = new URL('../prompts/more-options.md', import.meta.url);

const OptionArraySchema = z.array(OptionSchema).min(1);

interface MoreOptionsArgs {
  callModel: CallModel;
  slide: Slide;
  count: number;
  model?: string;
}

export async function generateMoreOptions(args: MoreOptionsArgs): Promise<DeckOption[]> {
  const systemPrompt = readFileSync(PROMPT_URL, 'utf8');
  const existingLabels = args.slide.options.map((o) => `- ${o.label}: ${o.description}`).join('\n');
  const user = [
    `Slide title: ${args.slide.title}`,
    `Slide context: ${args.slide.context}`,
    'Existing options:',
    existingLabels,
    `Produce ${args.count} new distinct option(s). JSON array only.`,
  ].join('\n\n');
  const response = await args.callModel({
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: user,
      },
    ],
    model: args.model,
    temperature: 0.9,
  });
  const parsed = OptionArraySchema.safeParse(extractJson(response.text));
  if (!parsed.success) {
    throw new Error(`More-options generation failed schema check: ${parsed.error.message}`);
  }
  return parsed.data.slice(0, args.count);
}
