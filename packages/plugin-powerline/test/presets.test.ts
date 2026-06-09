import { describe, expect, test } from 'bun:test';
import type { FooterContext } from '@noetic-tools/cli';

import { DEFAULT_THEME } from '../src/colors.js';
import { resolveIcons } from '../src/icons.js';
import type { PresetName } from '../src/options.js';
import { PRESETS } from '../src/presets.js';
import { resolveSegments } from '../src/segments/registry.js';

const PRESET_NAMES: PresetName[] = [
  'default',
  'minimal',
  'compact',
  'full',
  'nerd',
  'ascii',
];

function fixtureCtx(): FooterContext {
  return {
    model: 'anthropic/claude-sonnet-4',
    cwd: '/Users/dev/project',
    status: 'ready',
    lastLayerUsage: {
      executionId: 'exec-1',
      modelId: 'anthropic/claude-sonnet-4',
      layers: [],
      systemPromptTokens: 1e3,
      toolsTokens: 5e2,
      historyTokens: 2e3,
      totalUsedTokens: 45e3,
    },
    contextLimit: 2e5,
    threadId: 't-1',
    sessionStartedAt: Date.now() - 12 * 1e4,
    entryCount: 4,
  };
}

describe('presets', () => {
  test.each(PRESET_NAMES)('preset "%s" renders every segment without throwing', (name) => {
    const ctx = fixtureCtx();
    const icons = resolveIcons(true);
    const segments = resolveSegments(PRESETS[name]);
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      const result = seg.render({
        ctx,
        theme: DEFAULT_THEME,
        icons,
        git: {
          branch: 'main',
          staged: 1,
          unstaged: 0,
          untracked: 0,
        },
        now: Date.now(),
      });
      if (result !== null) {
        expect(typeof result.text).toBe('string');
        expect(result.fg.startsWith('#')).toBe(true);
        expect(result.bg.startsWith('#')).toBe(true);
      }
    }
  });
});
