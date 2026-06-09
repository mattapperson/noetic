import type { Command, PluginContext } from '@noetic-tools/cli';
import type { ReactNode } from 'react';

import type { DesignDeckOptions } from '../options.js';
import { DeckModal } from '../ui/deck-modal.js';
import { LoaderModal } from '../ui/loader-modal.js';

interface Deps {
  ctx: PluginContext;
  options: DesignDeckOptions;
}

export function deckCommand({ ctx, options }: Deps): Command {
  return {
    name: 'deck',
    description: 'Open a design deck to pick one option per slide',
    type: 'local-jsx',
    load: async () => ({
      call: async (
        onDone: (result?: string) => void,
        _cmdCtx,
        args: string,
      ): Promise<ReactNode> => {
        const topic = args.trim();
        const dataDir = ctx.dataDir('project');
        const sharedProps = {
          callModel: ctx.callModel,
          dataDir,
          generateCount: options.generateCount,
          maxOptionsPerSlide: options.maxOptionsPerSlide,
          autoSaveOnSubmit: options.autoSaveOnSubmit,
          autoSaveOnCancel: options.autoSaveOnCancel,
          generateModel: options.generateModel,
          onDone: (summary: string) => onDone(summary),
        };
        if (topic.length === 0) {
          return (
            <DeckModal
              {...sharedProps}
              deck={{
                title: 'Empty deck',
                slides: [
                  {
                    id: 'topic-missing',
                    title: 'Provide a topic',
                    context: 'Run `/deck <topic>` or try `/deck-discover`.',
                    options: [
                      {
                        label: 'OK',
                        description: 'Close this deck.',
                        previewBlocks: [],
                      },
                    ],
                  },
                ],
              }}
            />
          );
        }
        return <LoaderModal {...sharedProps} topic={topic} />;
      },
    }),
  };
}
