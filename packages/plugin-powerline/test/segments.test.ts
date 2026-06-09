import { describe, expect, test } from 'bun:test';
import type { FooterContext } from '@noetic-tools/cli';

import { DEFAULT_THEME } from '../src/colors.js';
import { resolveIcons } from '../src/icons.js';
import { gitSegment } from '../src/segments/git.js';
import { contextPctSegment, tokensSegment } from '../src/segments/tokens.js';

const ICONS = resolveIcons(false);

function buildCtx(overrides: Partial<FooterContext> = {}): FooterContext {
  return {
    model: 'anthropic/claude-sonnet-4',
    cwd: '/tmp/project',
    status: 'ready',
    lastLayerUsage: undefined,
    contextLimit: 2e5,
    threadId: 't',
    sessionStartedAt: Date.now(),
    entryCount: 0,
    ...overrides,
  };
}

describe('gitSegment', () => {
  test('returns null when not in a git repo', () => {
    const out = gitSegment({
      ctx: buildCtx(),
      theme: DEFAULT_THEME,
      icons: ICONS,
      git: null,
      now: Date.now(),
    });
    expect(out).toBeNull();
  });

  test('shows branch name when clean', () => {
    const out = gitSegment({
      ctx: buildCtx(),
      theme: DEFAULT_THEME,
      icons: ICONS,
      git: {
        branch: 'main',
        staged: 0,
        unstaged: 0,
        untracked: 0,
      },
      now: Date.now(),
    });
    expect(out?.text.endsWith('main')).toBe(true);
    expect(out?.bg).toBe(DEFAULT_THEME.git);
  });

  test('marks dirty with * and uses dirty bg', () => {
    const out = gitSegment({
      ctx: buildCtx(),
      theme: DEFAULT_THEME,
      icons: ICONS,
      git: {
        branch: 'feature',
        staged: 1,
        unstaged: 2,
        untracked: 0,
      },
      now: Date.now(),
    });
    expect(out?.text.includes('feature*')).toBe(true);
    expect(out?.bg).toBe(DEFAULT_THEME.gitDirty);
  });
});

describe('tokensSegment / contextPctSegment', () => {
  test('returns null when no usage yet', () => {
    const args = {
      ctx: buildCtx(),
      theme: DEFAULT_THEME,
      icons: ICONS,
      git: null,
      now: Date.now(),
    };
    expect(tokensSegment(args)).toBeNull();
    expect(contextPctSegment(args)).toBeNull();
  });

  test('formats tokens and respects thresholds', () => {
    const ctx = buildCtx({
      lastLayerUsage: {
        executionId: 'e',
        modelId: 'm',
        layers: [],
        systemPromptTokens: 0,
        toolsTokens: 0,
        historyTokens: 0,
        totalUsedTokens: 15e4,
      },
      contextLimit: 2e5,
    });
    const args = {
      ctx,
      theme: DEFAULT_THEME,
      icons: ICONS,
      git: null,
      now: Date.now(),
    };
    const tokens = tokensSegment(args);
    expect(tokens?.text.includes('150.0k/200.0k')).toBe(true);
    const pct = contextPctSegment(args);
    // 150k/200k = 75%, should hit warn
    expect(pct?.bg).toBe(DEFAULT_THEME.contextWarn);
  });

  test('crit threshold at 90%', () => {
    const ctx = buildCtx({
      lastLayerUsage: {
        executionId: 'e',
        modelId: 'm',
        layers: [],
        systemPromptTokens: 0,
        toolsTokens: 0,
        historyTokens: 0,
        totalUsedTokens: 19e4,
      },
      contextLimit: 2e5,
    });
    const args = {
      ctx,
      theme: DEFAULT_THEME,
      icons: ICONS,
      git: null,
      now: Date.now(),
    };
    expect(contextPctSegment(args)?.bg).toBe(DEFAULT_THEME.contextCrit);
  });

  test('green below warn threshold', () => {
    const ctx = buildCtx({
      lastLayerUsage: {
        executionId: 'e',
        modelId: 'm',
        layers: [],
        systemPromptTokens: 0,
        toolsTokens: 0,
        historyTokens: 0,
        totalUsedTokens: 5e4,
      },
      contextLimit: 2e5,
    });
    const args = {
      ctx,
      theme: DEFAULT_THEME,
      icons: ICONS,
      git: null,
      now: Date.now(),
    };
    expect(contextPctSegment(args)?.bg).toBe(DEFAULT_THEME.context);
  });
});
