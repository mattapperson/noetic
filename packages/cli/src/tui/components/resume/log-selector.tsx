/**
 * Interactive session picker. Adapted from Claude Code's `LogSelector`
 * (src/components/LogSelector.tsx) — we keep the UX (keyboard nav, filter
 * typing, same-project toggle, tag filter) but rewire to Ink 7 + our theme
 * and drop the tree/fuzzy/agentic-search machinery. For Claude Code's
 * original implementation see `_upstream/LogSelector.tsx.reference`.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type { SessionMetadata } from '../../../sessions/types.js';
import { useTheme } from '../theme.js';
import { formatRelativeTimeAgo, truncateFirstPrompt } from './format.js';
import { shouldCancelOnKey } from './resume-screen.js';
import { SessionPreview } from './session-preview.js';
import { TagTabs } from './tag-tabs.js';

//#region Types

export interface LogSelectorProps {
  /** Sessions in the current project slug. */
  sameProjectSessions: ReadonlyArray<SessionMetadata>;
  /** Sessions across all project slugs (used when toggled on). */
  allProjectsSessions: ReadonlyArray<SessionMetadata>;
  onSelect: (session: SessionMetadata) => void;
  onCancel: () => void;
}

//#endregion

//#region Helpers

const VISIBLE_ROWS = 10;

function matchesFilter(session: SessionMetadata, filter: string): boolean {
  if (filter.length === 0) {
    return true;
  }
  const needle = filter.toLowerCase();
  if (session.firstPrompt.toLowerCase().includes(needle)) {
    return true;
  }
  if (session.customTitle?.toLowerCase().includes(needle)) {
    return true;
  }
  if (session.tag?.toLowerCase().includes(needle)) {
    return true;
  }
  if (session.sessionId.toLowerCase().startsWith(needle)) {
    return true;
  }
  return false;
}

function distinctTags(sessions: ReadonlyArray<SessionMetadata>): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    if (s.tag !== undefined) {
      set.add(s.tag);
    }
  }
  return [
    ...set,
  ].sort();
}

function buildVisibleWindow<T>(
  items: ReadonlyArray<T>,
  cursor: number,
  size: number,
): {
  start: number;
  end: number;
} {
  if (items.length <= size) {
    return {
      start: 0,
      end: items.length,
    };
  }
  const half = Math.floor(size / 2);
  let start = Math.max(0, cursor - half);
  const end = Math.min(items.length, start + size);
  start = Math.max(0, end - size);
  return {
    start,
    end,
  };
}

//#endregion

//#region Row

interface RowProps {
  session: SessionMetadata;
  isFocused: boolean;
  showCwd: boolean;
}

function SessionRow({ session, isFocused, showCwd }: RowProps): ReactNode {
  const theme = useTheme();
  const marker = isFocused ? '❯ ' : '  ';
  const color = isFocused ? theme.primary : theme.foreground;
  const title = session.customTitle ?? truncateFirstPrompt(session.firstPrompt, 80);
  const meta = `${formatRelativeTimeAgo(session.modifiedAt)} · ${session.messageCount} msgs`;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{marker}</Text>
        <Text color={color} bold={isFocused}>
          {title.length > 0 ? title : '(no title)'}
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>{meta}</Text>
        {session.tag !== undefined ? (
          <>
            <Text dimColor> · </Text>
            <Text color={theme.accent}>#{session.tag}</Text>
          </>
        ) : null}
        {showCwd ? (
          <>
            <Text dimColor> · </Text>
            <Text dimColor>{session.cwd}</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}

//#endregion

//#region Picker

export function LogSelector({
  sameProjectSessions,
  allProjectsSessions,
  onSelect,
  onCancel,
}: LogSelectorProps): ReactNode {
  const theme = useTheme();
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const [allProjects, setAllProjects] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const pool = allProjects ? allProjectsSessions : sameProjectSessions;
  const tags = useMemo(
    () => distinctTags(pool),
    [
      pool,
    ],
  );

  const filtered = useMemo(
    () =>
      pool.filter((s) => matchesFilter(s, filter) && (activeTag === null || s.tag === activeTag)),
    [
      pool,
      filter,
      activeTag,
    ],
  );

  const clampedCursor = filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1);

  useInput((input, key) => {
    if (shouldCancelOnKey(input, key)) {
      onCancel();
      return;
    }
    if (key.return) {
      const picked = filtered[clampedCursor];
      if (picked) {
        onSelect(picked);
      }
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(Math.max(0, filtered.length - 1), c + 1));
      return;
    }
    if (key.pageUp) {
      setCursor((c) => Math.max(0, c - VISIBLE_ROWS));
      return;
    }
    if (key.pageDown) {
      setCursor((c) => Math.min(Math.max(0, filtered.length - 1), c + VISIBLE_ROWS));
      return;
    }
    if (key.ctrl && input === 'a') {
      setAllProjects((v) => !v);
      setCursor(0);
      return;
    }
    if (key.tab) {
      // cycle through: null (all) → tag[0] → tag[1] → ... → null
      if (tags.length === 0) {
        return;
      }
      setActiveTag((current) => {
        if (current === null) {
          return tags[0] ?? null;
        }
        const idx = tags.indexOf(current);
        return idx === -1 || idx + 1 >= tags.length ? null : tags[idx + 1];
      });
      setCursor(0);
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setCursor(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setFilter((f) => f + input);
      setCursor(0);
    }
  });

  const visibleWindow = useMemo(
    () => buildVisibleWindow(filtered, clampedCursor, VISIBLE_ROWS),
    [
      filtered,
      clampedCursor,
    ],
  );

  const focused = filtered[clampedCursor];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} padding={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color={theme.primary}>
          Resume session
        </Text>
        <Text dimColor>
          {allProjects
            ? 'showing all projects · Ctrl+A to show current project only'
            : 'showing current project · Ctrl+A to show all projects'}
        </Text>
      </Box>

      {tags.length > 0 ? (
        <Box marginBottom={1}>
          <TagTabs tags={tags} activeTag={activeTag} />
        </Box>
      ) : null}

      <Box marginBottom={1}>
        <Text color={theme.muted}>filter: </Text>
        <Text color={theme.foreground}>{filter}</Text>
        <Text color={theme.muted}>█</Text>
      </Box>

      {filtered.length === 0 ? (
        <Box marginBottom={1}>
          <Text dimColor>
            {pool.length === 0 ? 'No saved sessions yet.' : `No sessions match "${filter}".`}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {visibleWindow.start > 0 ? (
            <Text dimColor> ↑ {visibleWindow.start} more above</Text>
          ) : null}
          {filtered.slice(visibleWindow.start, visibleWindow.end).map((s, i) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              isFocused={visibleWindow.start + i === clampedCursor}
              showCwd={allProjects}
            />
          ))}
          {visibleWindow.end < filtered.length ? (
            <Text dimColor> ↓ {filtered.length - visibleWindow.end} more below</Text>
          ) : null}
        </Box>
      )}

      {focused !== undefined ? (
        <Box marginTop={1} marginBottom={1} borderStyle="single" borderColor={theme.muted}>
          <SessionPreview session={focused} />
        </Box>
      ) : null}

      <Box>
        <Text color={theme.success}>[Enter] resume</Text>
        <Text>{'  '}</Text>
        <Text color={theme.error}>[Esc] cancel</Text>
        <Text>{'  '}</Text>
        <Text dimColor>↑/↓ nav · Tab tag · Ctrl+A scope · type filter</Text>
      </Box>
    </Box>
  );
}

//#endregion
