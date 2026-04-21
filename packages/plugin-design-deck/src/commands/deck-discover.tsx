import type { Command, PluginContext } from '@noetic/cli';
import type { ReactNode } from 'react';

import type { DesignDeckOptions } from '../options.js';
import { DiscoverModal } from '../ui/discover-modal.js';

interface Deps {
  ctx: PluginContext;
  options: DesignDeckOptions;
}

export function deckDiscoverCommand({ ctx, options }: Deps): Command {
  return {
    name: 'deck-discover',
    description: 'Interview-driven deck: answer a few questions, get a deck',
    type: 'local-jsx',
    load: async () => ({
      call: async (onDone: (result?: string) => void): Promise<ReactNode> => {
        const dataDir = ctx.dataDir('project');
        return (
          <DiscoverModal
            callModel={ctx.callModel}
            dataDir={dataDir}
            generateCount={options.generateCount}
            maxOptionsPerSlide={options.maxOptionsPerSlide}
            autoSaveOnSubmit={options.autoSaveOnSubmit}
            autoSaveOnCancel={options.autoSaveOnCancel}
            generateModel={options.generateModel}
            onDone={(summary) => onDone(summary)}
          />
        );
      },
    }),
  };
}
