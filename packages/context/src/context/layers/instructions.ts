import type { ContextLayer, ContextScope } from '@noetic-tools/types';
import { estimateTokens, Slot } from '@noetic-tools/types';

interface InstructionsOptions {
  id?: string;
  slot?: number;
  scope?: ContextScope;
  load: () => Promise<string>;
  tag?: string;
}

/**
 * Creates a read-only context layer that loads static content once at init and injects it into recall.
 *
 * @public
 * @param opts - Configuration with a `load` function and optional id, slot, scope, and XML tag name.
 * @returns A `ContextLayer` that provides static instructional content to the model.
 */
export function instructions(opts: InstructionsOptions) {
  const tag = opts.tag ?? 'instructions';

  return {
    id: opts.id ?? 'instructions',
    slot: opts.slot ?? Slot.WORKING_MEMORY + 5,
    scope: opts.scope ?? 'resource',
    // Loaded once in `init` and never rewritten, so it can be pinned outright
    // rather than waiting for churn telemetry to work that out.
    placement: 'anchor',
    hooks: {
      async init() {
        const raw = await opts.load();
        if (!raw) {
          return {
            state: '',
          };
        }
        return {
          state: `<${tag}>\n${raw}\n</${tag}>`,
        };
      },

      async recall({ state, budget }) {
        if (!state) {
          return null;
        }
        // `budget > 0` is a deliberate fail-open guard: a zero allocation must
        // not delete the instructions (slice(0, 0) would silently drop the
        // whole layer from the view).
        if (budget > 0 && estimateTokens(state) > budget) {
          // Trim so the recalled text fits the token budget (~4 chars/token),
          // reserving room for the closing tag so the block stays well-formed
          // XML instead of being cut mid-tag/mid-sentence.
          const closing = `\n</${tag}>`;
          const maxChars = Math.max(0, budget * 4 - closing.length);
          return `${state.slice(0, maxChars)}${closing}`;
        }
        return state;
      },
    },
  } satisfies ContextLayer<string>;
}
