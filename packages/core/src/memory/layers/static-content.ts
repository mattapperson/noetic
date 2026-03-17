import type { MemoryLayer, MemoryScope } from '../../types/memory';
import { Slot } from '../../types/memory';

interface StaticContentOpts {
  id?: string;
  slot?: number;
  scope?: MemoryScope;
  load: () => Promise<string>;
  tag?: string;
}

export function staticContent(opts: StaticContentOpts): MemoryLayer<string> {
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
  };
}
