/**
 * Drill-in for structured tasks. Reads the milestone → slice → feature
 * hierarchy via `getTaskHierarchy` and renders it as an indented tree
 * with status indicators (✓ done, ▶ active, … pending, ✕ blocked).
 *
 * Esc returns to the kanban. Pure helpers are exported for unit tests.
 */

import type { Task } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import type { FsAdapter } from '@noetic/core';
import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from '../../components/theme.js';
import { getTaskHierarchy } from '../../../tasks/runtime/hierarchy/aggregate.js';
import type {
  FeatureStatus,
  MilestoneStatus,
  SliceStatus,
  TaskHierarchy,
} from '../../../tasks/runtime/hierarchy/schemas.js';

//#region Types

export interface TaskHierarchyViewProps {
  task: Task;
  fs: FsAdapter;
  projectRoot: string;
  onClose: () => void;
}

interface HierarchyData {
  readonly hierarchy: TaskHierarchy | null;
  readonly error: string | null;
  readonly loaded: boolean;
}

//#endregion

//#region Helpers

const EMPTY_HIERARCHY_DATA: HierarchyData = {
  hierarchy: null,
  error: null,
  loaded: false,
};

const STATUS_GLYPHS = {
  active: '▶',
  complete: '✓',
  pending: '…',
  blocked: '✕',
  defined: '·',
  triaged: '*',
  done: '✓',
} as const;

/** Map a milestone/slice/feature status to a 1-character glyph. */
export function statusGlyph(status: MilestoneStatus | SliceStatus | FeatureStatus): string {
  if (status === 'active') {
    return STATUS_GLYPHS.active;
  }
  if (status === 'complete' || status === 'done') {
    return STATUS_GLYPHS.complete;
  }
  if (status === 'blocked') {
    return STATUS_GLYPHS.blocked;
  }
  if (status === 'triaged') {
    return STATUS_GLYPHS.triaged;
  }
  if (status === 'defined') {
    return STATUS_GLYPHS.defined;
  }
  return STATUS_GLYPHS.pending;
}

async function loadHierarchyData(opts: {
  ctx: TaskStoreContext;
  taskId: string;
}): Promise<HierarchyData> {
  try {
    const hierarchy = await getTaskHierarchy(opts.ctx, opts.taskId);
    return {
      hierarchy,
      error: null,
      loaded: true,
    };
  } catch (err) {
    return {
      hierarchy: null,
      error: err instanceof Error ? err.message : String(err),
      loaded: true,
    };
  }
}

//#endregion

//#region Component

export function TaskHierarchyView(props: TaskHierarchyViewProps): React.ReactElement {
  const theme = useTheme();
  const [data, setData] = useState<HierarchyData>(EMPTY_HIERARCHY_DATA);

  const ctx = useMemo<TaskStoreContext>(
    () => ({
      fs: props.fs,
      projectRoot: props.projectRoot,
    }),
    [
      props.fs,
      props.projectRoot,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    void loadHierarchyData({
      ctx,
      taskId: props.task.id,
    }).then((next) => {
      if (cancelled) {
        return;
      }
      setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, [
    ctx,
    props.task.id,
  ]);

  useInput((_input, key) => {
    if (key.escape) {
      props.onClose();
    }
  });

  if (!data.loaded) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.muted}>Loading hierarchy for {props.task.id}...</Text>
      </Box>
    );
  }

  if (data.error !== null) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.error}>Failed to load hierarchy: {data.error}</Text>
        <Text color={theme.muted}>Esc to return</Text>
      </Box>
    );
  }

  if (data.hierarchy === null) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.muted}>This task has no hierarchy.</Text>
        <Text color={theme.muted}>Esc to return</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.primary}>{props.task.title}</Text>
        <Text color={theme.muted}> — hierarchy</Text>
      </Box>
      {data.hierarchy.milestones.map((milestone) => (
        <Box key={milestone.id} flexDirection="column" marginTop={1}>
          <Text color={theme.accent}>
            {statusGlyph(milestone.status)} Milestone: {milestone.title}
          </Text>
          {milestone.slices.map((slice) => (
            <Box key={slice.id} flexDirection="column" marginLeft={2}>
              <Text>
                {statusGlyph(slice.status)} Slice: {slice.title}
              </Text>
              {slice.features.map((feature) => (
                <Box key={feature.id} marginLeft={2}>
                  <Text wrap="truncate-end">
                    {statusGlyph(feature.status)} Feature: {feature.title} ({feature.loopState})
                  </Text>
                </Box>
              ))}
            </Box>
          ))}
          {milestone.assertions.length > 0 ? (
            <Box flexDirection="column" marginLeft={2}>
              <Text color={theme.muted}>Assertions:</Text>
              {milestone.assertions.map((assertion) => (
                <Box key={assertion.id} marginLeft={2}>
                  <Text wrap="truncate-end" color={theme.muted}>
                    · {assertion.title}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={theme.muted}>Esc to return</Text>
      </Box>
    </Box>
  );
}

//#endregion
