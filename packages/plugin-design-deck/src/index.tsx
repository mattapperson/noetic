/**
 * @noetic/plugin-design-deck
 *
 * Interactive visual-decision modal for the Noetic CLI. Renders a deck of
 * slides where the user picks one option per slide, then returns the
 * selections to chat so the next agent turn can act on them.
 *
 * Ported (UI-layer rewritten) from https://github.com/nicobailon/pi-design-deck.
 *
 * Usage (in noetic.config.ts):
 * ```ts
 * import designDeck from '@noetic/plugin-design-deck';
 *
 * export default {
 *   plugins: [ designDeck({ generateCount: 3 }) ],
 * };
 * ```
 */

import type { NoeticPlugin } from '@noetic/cli';

import { deckCommand } from './commands/deck.js';
import { deckDiscoverCommand } from './commands/deck-discover.js';
import type { DesignDeckInput } from './options.js';
import { DesignDeckInputSchema, DesignDeckOptionsSchema } from './options.js';

const NAME = '@noetic/plugin-design-deck';
const VERSION = '0.1.0';

export default function designDeck(userInput: DesignDeckInput = {}): NoeticPlugin {
  const inputParsed = DesignDeckInputSchema.parse(userInput);
  const options = DesignDeckOptionsSchema.parse(inputParsed);

  return {
    name: NAME,
    version: VERSION,
    commands: (ctx) => [
      deckCommand({
        ctx,
        options,
      }),
      deckDiscoverCommand({
        ctx,
        options,
      }),
    ],
  };
}

export type { DesignDeckInput, DesignDeckOptions } from './options.js';
export type {
  Deck,
  DeckOption,
  DeckSelections,
  PreviewBlock,
  Slide,
} from './types.js';
