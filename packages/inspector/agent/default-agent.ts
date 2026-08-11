/**
 * The starter agent the inspector opens with. Edit freely — saving hot-reloads
 * this file into the running session without losing chat history.
 *
 * Contract: export `createAgent(deps)` returning `{ harness }`. The inspector
 * injects `deps.storage` (durable context-layer state under .data/storage) and
 * `deps.traceExporter` (feeds the Trace tab) — pass both to the harness or
 * those panels go dark.
 *
 * The note tools write through `toolCtx.memory` into the scratchpad
 * layer's state — watch its tab light up when a note is saved, and the
 * Context tab render it into the next turn's window.
 *
 * Model calls go through OpenRouter: set OPENROUTER_API_KEY before launching.
 */

import type {
  ContextData,
  StorageAdapter,
  TraceExporter,
  WorkingMemoryContextState,
} from '@noetic-tools/core';
import {
  AgentHarness,
  history,
  instructions,
  observations,
  plan,
  scratchpad,
  step,
  temporal,
  tool,
} from '@noetic-tools/core';
import { z } from 'zod';

//#region Tools

const SCRATCHPAD_LAYER_ID = 'scratchpad';

const NotesSchema = z.object({
  notes: z.array(z.string()),
});

function readNotes(state: WorkingMemoryContextState | undefined): string[] {
  const parsed = NotesSchema.safeParse(state);
  return parsed.success
    ? [
        ...parsed.data.notes,
      ]
    : [];
}

const saveNote = tool({
  name: 'save_note',
  description:
    "Save a short note into the scratchpad. Saved notes render into the agent's context window on every later turn.",
  input: z.object({
    text: z.string().describe('The note to save.'),
  }),
  output: z.object({
    saved: z.boolean(),
    count: z.number(),
  }),
  async execute({ text }, toolCtx) {
    const notes = readNotes(toolCtx.memory.get<WorkingMemoryContextState>(SCRATCHPAD_LAYER_ID));
    notes.push(text);
    toolCtx.memory.set<WorkingMemoryContextState>(SCRATCHPAD_LAYER_ID, {
      notes,
    });
    return {
      saved: true,
      count: notes.length,
    };
  },
});

const listNotes = tool({
  name: 'list_notes',
  description: 'List the notes currently held in the scratchpad.',
  input: z.object({}),
  output: z.object({
    notes: z.array(z.string()),
  }),
  async execute(_args, toolCtx) {
    return {
      notes: readNotes(toolCtx.memory.get<WorkingMemoryContextState>(SCRATCHPAD_LAYER_ID)),
    };
  },
});

//#endregion

//#region Agent

const PERSONA = [
  'You are a research assistant running inside the Noetic Inspector.',
  'Be concise. Use save_note when the user shares a fact worth keeping,',
  'and list_notes when they ask what you know so far.',
].join('\n');

const chat = step.llm<ContextData, string, string>({
  id: 'chat',
  model: 'anthropic/claude-sonnet-4.5',
  instructions: PERSONA,
  tools: [
    saveNote,
    listNotes,
  ],
});

export function createAgent(deps: { storage: StorageAdapter; traceExporter: TraceExporter }): {
  harness: AgentHarness;
} {
  const harness = new AgentHarness({
    name: 'inspector-agent',
    initialStep: chat,
    params: {},
    storage: deps.storage,
    traceExporter: deps.traceExporter,
    context: [
      instructions({
        id: 'persona',
        load: async () => PERSONA,
      }),
      scratchpad(),
      plan(),
      observations(),
      temporal(),
      history(),
    ],
    llm: {
      provider: 'openrouter',
    },
  });
  return {
    harness,
  };
}

//#endregion
