/**
 * @noetic/plugin-powerline
 *
 * Powerline-style footer + themed working-vibes loading messages for the
 * Noetic CLI. Inspired by https://github.com/nicobailon/pi-powerline-footer.
 *
 * Usage (in noetic.config.ts):
 *
 * ```ts
 * import powerline from '@noetic/plugin-powerline';
 *
 * export default defineConfig({
 *   plugins: [
 *     powerline({ preset: 'nerd', vibe: { theme: 'startrek', mode: 'generate' } }),
 *   ],
 * });
 * ```
 */

import type { NoeticPlugin } from '@noetic-tools/cli';
import type { ReactNode } from 'react';

import { Footer } from './footer.js';
import { resolveIcons } from './icons.js';
import { detectNerdFonts } from './nerd-fonts.js';
import type { PowerlineInput } from './options.js';
import { PowerlineInputSchema, PowerlineOptionsSchema } from './options.js';
import { PRESETS } from './presets.js';
import { resolveSeparators } from './separators.js';
import { loadTheme } from './theme.js';
import { resolveVibes } from './working-vibes/index.js';

const NAME = '@noetic/plugin-powerline';
const VERSION = '0.1.0';

export default function powerline(userInput: PowerlineInput = {}): NoeticPlugin {
  const inputParsed = PowerlineInputSchema.parse(userInput);
  const options = PowerlineOptionsSchema.parse(inputParsed);

  let vibes: ReadonlyArray<string> = [];

  const segments = options.segments ?? PRESETS[options.preset];

  return {
    name: NAME,
    version: VERSION,
    initialize: async (ctx) => {
      vibes = await resolveVibes({
        options: options.vibe,
        apiKey: ctx.config.apiKey,
      });
    },
    loadingMessages: () => vibes,
    footer: (): ReactNode => {
      const nerd = detectNerdFonts(options.nerdFonts);
      const theme = loadTheme(options.theme);
      const icons = resolveIcons(nerd);
      const separators = resolveSeparators(nerd);
      return (
        <Footer
          segments={segments}
          theme={theme}
          icons={icons}
          separators={separators}
          useNerdSeparators={nerd}
        />
      );
    },
  };
}

export type { PowerlineInput, PowerlineOptions } from './options.js';
export { PRESETS } from './presets.js';
