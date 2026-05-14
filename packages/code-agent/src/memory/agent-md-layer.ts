/**
 * AGENT.md memory layer — surfaces project/user instruction files + rule sets.
 *
 * Loads once per execution (`scope: 'execution'`), caches the result in state,
 * and renders on every recall. Slot position is just ahead of observations so
 * that instruction files establish context before runtime observations do.
 */

import type { MemoryLayer } from '@noetic-tools/core';
import { Slot } from '@noetic-tools/core';

export interface AgentInstructionResult {
  text: string;
  sources: ReadonlyArray<unknown>;
  totalCapExceeded: boolean;
}

//#region Types

interface AgentMdLayerOpts {
  /** Async loader that returns the combined AGENT.md + rules content. */
  loader: () => Promise<AgentInstructionResult>;
}

//#endregion

//#region Constants

/** Sits just above OBSERVATIONS (200) so instructions appear before environment facts. */
const AGENT_MD_SLOT = Slot.OBSERVATIONS - 5;

//#endregion

//#region Public API

export function agentMdLayer(opts: AgentMdLayerOpts): MemoryLayer<AgentInstructionResult> {
  return {
    id: 'agent-md',
    name: 'AGENT.md',
    slot: AGENT_MD_SLOT,
    scope: 'execution',
    budget: {
      min: 0,
      max: 15_000,
    },
    hooks: {
      async init() {
        const state = await opts.loader();
        return {
          state,
        };
      },

      async recall({ state }) {
        if (state.sources.length === 0) {
          return null;
        }
        const capNote = state.totalCapExceeded
          ? '\n\n[Note: Some AGENT.md sources were omitted due to the 60KB total cap.]'
          : '';
        return `# Project & User Instructions (AGENT.md)\n\n${state.text}${capNote}`;
      },
    },
  };
}

//#endregion
