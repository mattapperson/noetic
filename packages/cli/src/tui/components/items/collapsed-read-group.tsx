/**
 * Renders a grouped run of Read/Ls/Find/Grep tool calls as a single dim line.
 * Handles both the singleton form (⎿ Read ~/path) and the multi form
 * (⎿ Read 3 files, listed 1 directory).
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';
import { EXPAND_HINT_TEXT } from '../../glyphs.js';
import type { CollapsedReadGroup } from '../../grouping/types.js';
import { totalOpCount } from '../../grouping/types.js';
import { relativizeHome } from '../../paths.js';
import { pluralize } from '../../plural.js';
import { MessageResponse } from './message-response.js';

//#region Helpers

function summarize(group: CollapsedReadGroup): string {
  const parts: string[] = [];
  const reads = group.readPaths.length;
  if (reads > 0) {
    parts.push(`Read ${reads} ${pluralize(reads, 'file', 'files')}`);
  }
  const lists = group.listPaths.length;
  if (lists > 0) {
    parts.push(`listed ${lists} ${pluralize(lists, 'directory', 'directories')}`);
  }
  const searches = group.searchPatterns.length;
  if (searches > 0) {
    parts.push(`searched ${searches} ${pluralize(searches, 'pattern', 'patterns')}`);
  }
  return parts.join(', ');
}

function singletonText(group: CollapsedReadGroup): string | null {
  if (totalOpCount(group) !== 1) {
    return null;
  }
  if (group.readPaths.length === 1) {
    return `Read ${relativizeHome(group.readPaths[0] ?? '')}`;
  }
  if (group.listPaths.length === 1) {
    return `Listed ${relativizeHome(group.listPaths[0] ?? '')}`;
  }
  if (group.searchPatterns.length === 1) {
    return `Searched for ${group.searchPatterns[0] ?? ''}`;
  }
  return null;
}

//#endregion

//#region Component

export interface CollapsedReadGroupViewProps {
  group: CollapsedReadGroup;
}

export function CollapsedReadGroupView({ group }: CollapsedReadGroupViewProps): ReactNode {
  if (totalOpCount(group) === 0) {
    return null;
  }
  const body = singletonText(group) ?? summarize(group);
  return (
    <MessageResponse>
      <Text dimColor>
        {body} {EXPAND_HINT_TEXT}
      </Text>
    </MessageResponse>
  );
}

//#endregion
