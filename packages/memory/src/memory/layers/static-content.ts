import type { MemoryLayer, MemoryScope } from '@noetic-tools/types';
import { Slot } from '@noetic-tools/types';

interface StaticContentOpts {
  id?: string;
  slot?: number;
  scope?: MemoryScope;
  load: () => Promise<string>;
  tag?: string;
}

/**
 * Creates a read-only memory layer that loads static content once at init and injects it into recall.
 *
 * @public
 * @param opts - Configuration with a `load` function and optional id, slot, scope, and XML tag name.
 * @returns A `MemoryLayer` that provides static instructional content to the model.
 */
export function staticContent(opts: StaticContentOpts) {
  const tag = opts.tag ?? 'instructions';

  return {
    id: opts.id ?? 'static-content',
    slot: opts.slot ?? Slot.WORKING_MEMORY + 5,
    scope: opts.scope ?? 'resource',
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

      async recall({ state }) {
        if (!state) {
          return null;
        }
        return state;
      },
    },
  } satisfies MemoryLayer<string>;
}
