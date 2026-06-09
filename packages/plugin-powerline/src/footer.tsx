import { useFooterContext } from '@noetic-tools/cli';
import { Box, Text, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { Fragment, useEffect, useState } from 'react';
import stringWidth from 'string-width';
import { fitSegments } from './fit.js';
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

interface NamedCell {
  readonly name: string;
  readonly out: SegmentOutput;
}

interface SeparatorProps {
  cell: SegmentOutput;
  next: SegmentOutput | undefined;
  useNerdSeparators: boolean;
  separators: SeparatorSet;
  separatorColor: string;
}

const GIT_REFRESH_MS = 1e3;
const CLOCK_REFRESH_MS = 1e3;
const FALLBACK_COLUMNS = 80;
const SAFETY_MARGIN = 1;
// ASCII separator renders as ` ${sep} ` — one leading + one trailing space.
const ASCII_SEPARATOR_PADDING = 2;
const TIME_DEPENDENT_SEGMENTS: ReadonlySet<string> = new Set([
  'clock',
  'session_time',
]);

function hasTimeSegment(segments: ReadonlyArray<string>): boolean {
  for (const name of segments) {
    if (TIME_DEPENDENT_SEGMENTS.has(name)) {
      return true;
    }
  }
  return false;
}

function renderSeparator({
  cell,
  next,
  useNerdSeparators,
  separators,
  separatorColor,
}: SeparatorProps): ReactNode {
  if (next && useNerdSeparators) {
    return (
      <Text backgroundColor={next.bg} color={cell.bg} wrap="truncate-end">
        {separators.main}
      </Text>
    );
  }
  if (next) {
    return (
      <Text color={separatorColor} wrap="truncate-end">
        {` ${separators.main} `}
      </Text>
    );
  }
  if (useNerdSeparators) {
    return (
      <Text color={cell.bg} wrap="truncate-end">
        {separators.main}
      </Text>
    );
  }
  return null;
}

export function Footer({
  segments,
  theme,
  icons,
  separators,
  useNerdSeparators,
}: FooterProps): ReactNode {
  const ctx = useFooterContext();
  const { stdout } = useStdout();
  const [git, setGit] = useState<GitStatus | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const needsClock = hasTimeSegment(segments);

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
    if (!needsClock) {
      return;
    }
    const interval = setInterval(() => setNow(Date.now()), CLOCK_REFRESH_MS);
    return () => clearInterval(interval);
  }, [
    needsClock,
  ]);

  const resolved = resolveSegments(segments);
  const rendered: NamedCell[] = [];
  for (const seg of resolved) {
    const out = seg.render({
      ctx,
      theme,
      icons,
      git,
      now,
    });
    if (out !== null) {
      rendered.push({
        name: seg.name,
        out,
      });
    }
  }
  if (rendered.length === 0) {
    return null;
  }

  const columns = stdout?.columns ?? FALLBACK_COLUMNS;
  const sepMainWidth = stringWidth(separators.main);
  const sepBetween = useNerdSeparators ? sepMainWidth : sepMainWidth + ASCII_SEPARATOR_PADDING;
  const sepTrailing = useNerdSeparators ? sepMainWidth : 0;
  const fitted = fitSegments<NamedCell>({
    cells: rendered,
    toText: (c) => c.out.text,
    withText: (c, text) => ({
      name: c.name,
      out: {
        ...c.out,
        text,
      },
    }),
    sepBetween,
    sepTrailing,
    budget: columns - SAFETY_MARGIN,
  });
  if (fitted.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="row">
      {fitted.map(({ name, out: cell }, idx) => (
        <Fragment key={name}>
          <Text backgroundColor={cell.bg} color={cell.fg} bold={cell.bold} wrap="truncate-end">
            {` ${cell.text} `}
          </Text>
          {renderSeparator({
            cell,
            next: fitted[idx + 1]?.out,
            useNerdSeparators,
            separators,
            separatorColor: theme.separator,
          })}
        </Fragment>
      ))}
    </Box>
  );
}
