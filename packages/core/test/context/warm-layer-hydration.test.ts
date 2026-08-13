/**
 * Warm layer hydration: successive turns addressing the same layer scope bucket
 * carry non-execution-scoped layer state forward IN MEMORY instead of re-reading
 * it from storage.
 *
 * Cold-initing every turn cost one sequential storage read per layer — each with
 * its own 10s timeout — on every single turn, for state the state store already
 * held. Execution-scoped layers are exempt: their scope key rotates per run, so
 * they must still init per turn by contract.
 */

import { describe, expect, it } from 'bun:test';
import type { ContextData, ContextLayer } from '@noetic-tools/context';
import type { LLMResponse, MessageItem, Step } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { assistantMessage, makeStorage } from '../_helpers';

interface CountState {
  count: number;
}

interface Probe {
  readonly layer: ContextLayer<CountState>;
  readonly inits: () => number;
}

/** A layer that counts how many times `init` ran, and bumps state per turn. */
function countingLayer(scope: 'thread' | 'execution'): Probe {
  let inits = 0;
  const layer: ContextLayer<CountState> = {
    id: `counter-${scope}`,
    slot: 100,
    scope,
    hooks: {
      async init({ storage }) {
        inits += 1;
        const saved = await storage.get<CountState>('state');
        return {
          state: saved ?? {
            count: 0,
          },
        };
      },
      async recall({ state }) {
        return `count=${state.count}`;
      },
      async store({ state }) {
        return {
          state: {
            count: (state?.count ?? 0) + 1,
          },
        };
      },
    },
  };
  return {
    layer,
    inits: () => inits,
  };
}

const chatStep: Step<ContextData, string, string> = {
  kind: 'callModel',
  id: 'chat',
  model: 'test/scripted',
  tools: [],
};

function harnessWith(layers: ContextLayer[]): AgentHarness {
  let call = 0;
  return new AgentHarness({
    name: 'warm-test',
    params: {},
    agentGraph: chatStep,
    environment: {
      storage: {
        adapter: makeStorage(),
      },
    },
    contextLayers: layers,
    _testCallModel: async (): Promise<LLMResponse> => {
      const message: MessageItem = assistantMessage(`answer ${call}`, `resp-${call}`);
      call += 1;
      return {
        items: [
          message,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 1,
        },
      };
    },
  });
}

async function runTurns(harness: AgentHarness, threadId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await harness.execute(`turn ${i}`, {
      threadId,
    });
    await harness.getAgentResponse({
      threadId,
    });
  }
}

describe('warm layer hydration across turns on one thread', () => {
  it('a thread-scoped layer inits once per thread, not once per turn', async () => {
    const probe = countingLayer('thread');
    const harness = harnessWith([
      probe.layer,
    ]);
    await runTurns(harness, 'warm', 3);
    expect(probe.inits()).toBe(1);
  });

  it('carried-forward state keeps accumulating across turns', async () => {
    const probe = countingLayer('thread');
    const harness = harnessWith([
      probe.layer,
    ]);
    await runTurns(harness, 'warm', 3);
    // `store` bumps the counter once per turn, and the warm path hands the live
    // state to the next turn — so a cold re-init would reset visible progress.
    const items = await harness.previewRequestItems({
      threadId: 'warm',
    });
    const texts = items.flatMap((item) =>
      item.type === 'message'
        ? item.content.flatMap((part) =>
            part.type === 'input_text' || part.type === 'output_text'
              ? [
                  part.text,
                ]
              : [],
          )
        : [],
    );
    expect(texts.some((t) => t.includes('count=3'))).toBe(true);
  });

  it('an execution-scoped layer still inits every turn', async () => {
    const probe = countingLayer('execution');
    const harness = harnessWith([
      probe.layer,
    ]);
    await runTurns(harness, 'warm', 3);
    expect(probe.inits()).toBe(3);
  });

  it('separate threads hydrate independently', async () => {
    const probe = countingLayer('thread');
    const harness = harnessWith([
      probe.layer,
    ]);
    await runTurns(harness, 'thread-a', 2);
    await runTurns(harness, 'thread-b', 2);
    // One cold init per thread — the scope key is thread-scoped, so thread B
    // cannot ride thread A's carry-forward.
    expect(probe.inits()).toBe(2);
  });

  it('a preview between turns does not poison the thread warm pointer', async () => {
    /* `previewRequestItems` inits layers on a THROWAWAY context and tears that
     * execution's state down in its `finally`. If the preview published itself as
     * the bucket's warm source, the next real turn would find a pointer to wiped
     * state, carry nothing forward, and silently cold-init — correct, but the
     * warm win would evaporate after any preview (a TUI may issue one per
     * keystroke). */
    const probe = countingLayer('thread');
    const harness = harnessWith([
      probe.layer,
    ]);
    await runTurns(harness, 'warm', 1);
    expect(probe.inits()).toBe(1);

    // Previews themselves ride the warm path off turn 1, so they add no inits...
    await harness.previewRequestItems({
      threadId: 'warm',
    });
    await harness.previewRequestItems({
      threadId: 'warm',
    });
    expect(probe.inits()).toBe(1);

    // ...and, crucially, they did not become the bucket's warm SOURCE. Turn 2
    // still resolves to turn 1's live state. Were the preview the source, its
    // `finally` (flush + cleanup) would have wiped that execution's state, the
    // warm copy would find nothing, and this turn would cold-init to 2.
    await runTurns(harness, 'warm', 1);
    expect(probe.inits()).toBe(1);
  });
});
