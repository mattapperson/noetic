import { useFooterContext } from '@noetic/cli';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { GitStatus } from './git-status.js';
import { getGitStatus } from './git-status.js';
import type { IconSet } from './icons.js';
import { resolveSegments } from './segments/registry.js';
import type { SegmentOutput } from './segments/types.js';
import type { SeparatorSet } from './separators.js';
import type { Theme } from './theme.js';

interface FooterProps {
  segments: ReadonlyArray<string>;
  theme: Theme;
  icons: IconSet;
  separators: SeparatorSet;
  useNerdSeparators: boolean;
}

const GIT_REFRESH_MS = 1e3;
const CLOCK_REFRESH_MS = 1e3;

export function Footer({
  segments,
  theme,
  icons,
  separators,
  useNerdSeparators,
}: FooterProps): ReactNode {
  const ctx = useFooterContext();
  const [git, setGit] = useState<GitStatus | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      const status = await getGitStatus(ctx.cwd);
      if (!cancelled) {
        setGit(status);
      }
    }
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, GIT_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    ctx.cwd,
  ]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), CLOCK_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  const resolved = resolveSegments(segments);
  const rendered: SegmentOutput[] = [];
  for (const seg of resolved) {
    const out = seg({
      ctx,
      theme,
      icons,
      git,
      now,
    });
    if (out !== null) {
      rendered.push(out);
    }
  }
  if (rendered.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="row">
      {rendered.map((cell, idx) => {
        const next = rendered[idx + 1];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: segment order is fixed by config
          <Box key={`${cell.bg}-${cell.text}-${idx}`} flexDirection="row">
            <Text backgroundColor={cell.bg} color={cell.fg} bold={cell.bold}>
              {` ${cell.text} `}
            </Text>
            {next ? (
              useNerdSeparators ? (
                <Text backgroundColor={next.bg} color={cell.bg}>
                  {separators.main}
                </Text>
              ) : (
                <Text color={theme.separator}>{` ${separators.main} `}</Text>
              )
            ) : useNerdSeparators ? (
              <Text color={cell.bg}>{separators.main}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
