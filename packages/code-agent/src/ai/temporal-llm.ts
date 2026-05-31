/**
 * LLM-backed callbacks for the core `temporalMemory` layer.
 *
 * `temporalMemory` is LLM-agnostic — it accepts injected `extract`/`search`
 * functions (mirrors `observationalMemory`'s `observer`) so `@noetic-tools/core`
 * stays free of a model client. The code agent supplies those functions here,
 * each running a structured `step.llm` (Zod `output`) through a dedicated bare
 * `AgentHarness`. A separate harness — not the agent's own — is used so the
 * extraction/search call does NOT re-enter the temporal layer (which would
 * recurse: store → extract → store …) and isn't polluted by the agent's memory.
 */

import type { FactExtractor, FactSearcher, LlmProviderConfig } from '@noetic-tools/core';
import { AgentHarness, step } from '@noetic-tools/core/portable';
import { z } from 'zod';

//#region Schemas

const ExtractSchema = z.object({
  facts: z.array(
    z.object({
      ts: z.string(),
      fact: z.string(),
    }),
  ),
});

const SearchSchema = z.object({
  facts: z.array(z.string()),
  date: z.string().optional(),
  fuzzy: z.boolean().optional(),
});

//#endregion

//#region Prompts

const EXTRACT_INSTRUCTIONS = [
  'Extract durable, timestamped facts about the USER from the conversation text.',
  'Output JSON { facts: [{ ts, fact }] }.',
  '- `ts` is an ISO-8601 timestamp (date or datetime) the fact is tied to. Resolve',
  '  relative time ("last Tuesday", "three weeks ago") against the provided Now.',
  '  If no time is implied, use Now.',
  '- `fact` is terse and self-contained.',
  '- Record ONLY facts actually stated; never infer or invent.',
  '- Emit every distinct instance/event/item on its own entry — downstream',
  '  questions count them.',
].join('\n');

const SEARCH_INSTRUCTIONS = [
  'You search a ledger of timestamped facts about the USER to answer a query.',
  'Output JSON { facts: string[], date?, fuzzy? }.',
  '- `facts`: the ledger lines relevant to the query, most relevant first.',
  '- `date`: if the query asks when something happened / how long ago, resolve it',
  '  against the provided Now and return the date (ISO-8601 or a natural phrase).',
  '- `fuzzy`: true when the resolved date is approximate.',
  'Use ONLY the provided facts; if nothing matches, return an empty facts array.',
].join('\n');

//#endregion

//#region Factories

interface TemporalLlmOpts {
  model: string;
  llm?: LlmProviderConfig;
}

/** Builds the `temporalMemory` fact extractor backed by a structured LLM call. */
export function createTemporalExtractor(opts: TemporalLlmOpts): FactExtractor {
  const extractStep = step.llm({
    id: 'temporal/extract',
    model: opts.model,
    instructions: EXTRACT_INSTRUCTIONS,
    output: ExtractSchema,
  });
  return async ({ transcript, now }) => {
    const harness = new AgentHarness({
      name: 'temporal-extract',
      params: {},
      llm: opts.llm,
    });
    const ctx = harness.createContext();
    const out = await harness.run(extractStep, `Now: ${now}\n\nCONVERSATION:\n${transcript}`, ctx);
    return out.facts;
  };
}

/** Builds the `temporalMemory` fact searcher backed by a structured LLM call. */
export function createTemporalSearcher(opts: TemporalLlmOpts): FactSearcher {
  const searchStep = step.llm({
    id: 'temporal/search',
    model: opts.model,
    instructions: SEARCH_INSTRUCTIONS,
    output: SearchSchema,
  });
  return async ({ query, facts, now }) => {
    const ledger = facts.map((f) => `- [${f.ts}] ${f.fact}`).join('\n');
    const harness = new AgentHarness({
      name: 'temporal-search',
      params: {},
      llm: opts.llm,
    });
    const ctx = harness.createContext();
    return harness.run(searchStep, `Now: ${now}\n\nFACTS:\n${ledger}\n\nQUERY: ${query}`, ctx);
  };
}

//#endregion
