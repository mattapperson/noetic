/**
 * MissionShowModal — Ink hierarchy view for a single mission.
 *
 * Tree: milestones → slices → features. Footer keybindings:
 *   a       activate selected slice
 *   t       trigger triage on selected feature/slice
 *   Enter   expand/collapse selected row
 *   Esc/q   close
 *
 * Per-row glyphs: ✓ done, ⏳ in-flight, ✗ blocked, ↻ needs_fix.
 * Fix-feature lineage: when `feature.generatedFromFeatureId !== null` we render a
 * `↳ fix #<source>` chip beside the title. Pressing Enter on that row reveals
 * the source feature id and the last validator failure summary.
 */

import { Box, Text, useInput, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { useTheme } from '../../../../../tui/components/theme.js';
import type { FeatureLoopState, MilestoneStatus, SliceStatus } from '../../db/schema.js';
import type {
  MissionHierarchy,
  MissionHierarchyFeature,
  MissionHierarchyMilestone,
  MissionHierarchySlice,
} from '../store.js';

//#region Row model

interface MilestoneRow {
  kind: 'milestone';
  id: string;
  milestone: MissionHierarchyMilestone;
}

interface SliceRow {
  kind: 'slice';
  id: string;
  slice: MissionHierarchySlice;
  milestoneId: string;
}

interface FeatureRow {
  kind: 'feature';
  id: string;
  feature: MissionHierarchyFeature;
  sliceId: string;
}

type Row = MilestoneRow | SliceRow | FeatureRow;

//#endregion

//#region Glyph + status helpers

function milestoneGlyph(status: MilestoneStatus): string {
  switch (status) {
    case 'complete':
      return '✓';
    case 'active':
      return '⏳';
    case 'blocked':
      return '✗';
    case 'pending':
      return '·';
  }
}

function sliceGlyph(status: SliceStatus): string {
  switch (status) {
    case 'complete':
      return '✓';
    case 'active':
      return '⏳';
    case 'blocked':
      return '✗';
    case 'pending':
      return '·';
  }
}

function featureGlyph(loopState: FeatureLoopState): string {
  switch (loopState) {
    case 'passed':
      return '✓';
    case 'implementing':
    case 'validating':
      return '⏳';
    case 'blocked':
      return '✗';
    case 'needs_fix':
      return '↻';
    case 'idle':
      return '·';
  }
}

//#endregion

//#region Component

export interface MissionShowModalProps {
  hierarchy: MissionHierarchy;
  databasePath: string;
  lastResult?: string | null;
  onClose: () => void;
  onActivateSlice?: (slice: MissionHierarchySlice) => void;
  onTriage?: (target: TriageTarget) => void;
}

export type TriageTarget =
  | {
      kind: 'slice';
      slice: MissionHierarchySlice;
    }
  | {
      kind: 'feature';
      feature: MissionHierarchyFeature;
    };

export function MissionShowModal(props: MissionShowModalProps): ReactNode {
  const { hierarchy, databasePath, lastResult, onClose, onActivateSlice, onTriage } = props;
  const theme = useTheme();
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 100;
  const terminalHeight = stdout?.rows ?? 28;

  const rows = useMemo<Row[]>(
    () => buildRows(hierarchy),
    [
      hierarchy,
    ],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
      return;
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex((current) => Math.min(Math.max(0, rows.length - 1), current + 1));
      return;
    }
    const selected = rows[selectedIndex];
    if (selected === undefined) {
      return;
    }
    if (key.return) {
      setExpandedIds((current) => {
        const next = new Set(current);
        if (next.has(selected.id)) {
          next.delete(selected.id);
        } else {
          next.add(selected.id);
        }
        return next;
      });
      return;
    }
    if (input === 'a' && selected.kind === 'slice' && onActivateSlice !== undefined) {
      onActivateSlice(selected.slice);
      return;
    }
    if (input === 't' && onTriage !== undefined) {
      if (selected.kind === 'slice') {
        onTriage({
          kind: 'slice',
          slice: selected.slice,
        });
        return;
      }
      if (selected.kind === 'feature') {
        onTriage({
          kind: 'feature',
          feature: selected.feature,
        });
      }
    }
  });

  const visibleCount = Math.max(1, terminalHeight - 12);
  const start = clampStart(selectedIndex, rows.length, visibleCount);
  const visibleRows = rows.slice(start, start + visibleCount);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
      paddingX={1}
      width={terminalWidth}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.primary}>Mission · {hierarchy.mission.title}</Text>
        <Text dimColor wrap="truncate-start">
          {hierarchy.mission.id}
        </Text>
        <Text dimColor wrap="truncate-start">
          {databasePath}
        </Text>
      </Box>

      {rows.length === 0 ? <Text dimColor>This mission has no milestones yet.</Text> : null}

      {visibleRows.map((row, idx) => {
        const absoluteIndex = start + idx;
        const selected = absoluteIndex === selectedIndex;
        const expanded = expandedIds.has(row.id);
        return (
          <RowView
            key={row.id}
            row={row}
            selected={selected}
            expanded={expanded}
            primaryColor={theme.primary}
            accentColor={theme.accent}
          />
        );
      })}

      {lastResult !== undefined && lastResult !== null ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {lastResult}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>a activate slice • t triage • Enter expand • q/Esc close</Text>
      </Box>
    </Box>
  );
}

//#endregion

//#region Row view

interface RowViewProps {
  row: Row;
  selected: boolean;
  expanded: boolean;
  primaryColor: string;
  accentColor: string;
}

function RowView({ row, selected, expanded, primaryColor, accentColor }: RowViewProps): ReactNode {
  const color = selected ? primaryColor : undefined;
  const marker = selected ? '>' : ' ';
  if (row.kind === 'milestone') {
    const glyph = milestoneGlyph(row.milestone.status);
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={color}>{`${marker} `}</Text>
          <Text color={color}>{`${glyph} `}</Text>
          <Text color={color} wrap="truncate-end">
            {row.milestone.title}
          </Text>
          <Text color={accentColor}>{`  [${row.milestone.status}]`}</Text>
        </Box>
        {expanded && row.milestone.description !== null ? (
          <Box marginLeft={4}>
            <Text dimColor>{row.milestone.description}</Text>
          </Box>
        ) : null}
        {expanded && row.milestone.verification.length > 0 ? (
          <Box marginLeft={4}>
            <Text dimColor>verify: {row.milestone.verification}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  if (row.kind === 'slice') {
    const glyph = sliceGlyph(row.slice.status);
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" paddingLeft={2}>
          <Text color={color}>{`${marker} `}</Text>
          <Text color={color}>{`${glyph} `}</Text>
          <Text color={color} wrap="truncate-end">
            {row.slice.title}
          </Text>
          <Text color={accentColor}>{`  [${row.slice.status}]`}</Text>
        </Box>
        {expanded && row.slice.description !== null ? (
          <Box marginLeft={6}>
            <Text dimColor>{row.slice.description}</Text>
          </Box>
        ) : null}
        {expanded && row.slice.verification.length > 0 ? (
          <Box marginLeft={6}>
            <Text dimColor>verify: {row.slice.verification}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  const glyph = featureGlyph(row.feature.loopState);
  const fixChip =
    row.feature.generatedFromFeatureId !== null
      ? ` ↳ fix of ${row.feature.generatedFromFeatureId.slice(0, 8)}`
      : '';
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" paddingLeft={4}>
        <Text color={color}>{`${marker} `}</Text>
        <Text color={color}>{`${glyph} `}</Text>
        <Text color={color} wrap="truncate-end">
          {row.feature.title}
        </Text>
        <Text color={accentColor}>{`  [${row.feature.loopState}]`}</Text>
        {fixChip.length > 0 ? <Text dimColor>{fixChip}</Text> : null}
      </Box>
      {expanded ? (
        <Box flexDirection="column" marginLeft={8}>
          {row.feature.description !== null ? (
            <Text dimColor>{row.feature.description}</Text>
          ) : null}
          {row.feature.acceptanceCriteriaParsed.length > 0 ? (
            <Box flexDirection="column">
              <Text dimColor>acceptance:</Text>
              {row.feature.acceptanceCriteriaParsed.map((criterion) => (
                <Text key={criterion} dimColor>
                  - {criterion}
                </Text>
              ))}
            </Box>
          ) : null}
          {row.feature.generatedFromFeatureId !== null ? (
            <Text dimColor>source feature: {row.feature.generatedFromFeatureId}</Text>
          ) : null}
          {row.feature.generatedFromRunId !== null ? (
            <Text dimColor>from validator run: {row.feature.generatedFromRunId}</Text>
          ) : null}
          {row.feature.blockedReason !== null && row.feature.blockedReason.length > 0 ? (
            <Text dimColor>blocked: {row.feature.blockedReason}</Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

//#endregion

//#region Helpers

function buildRows(hierarchy: MissionHierarchy): Row[] {
  const rows: Row[] = [];
  for (const milestone of hierarchy.milestones) {
    rows.push({
      kind: 'milestone',
      id: `milestone:${milestone.id}`,
      milestone,
    });
    for (const slice of milestone.slices) {
      rows.push({
        kind: 'slice',
        id: `slice:${slice.id}`,
        slice,
        milestoneId: milestone.id,
      });
      for (const feature of slice.features) {
        rows.push({
          kind: 'feature',
          id: `feature:${feature.id}`,
          feature,
          sliceId: slice.id,
        });
      }
    }
  }
  return rows;
}

function clampStart(selectedIndex: number, rowCount: number, visibleCount: number): number {
  return Math.max(
    0,
    Math.min(Math.max(0, selectedIndex - visibleCount + 1), Math.max(0, rowCount - visibleCount)),
  );
}

//#endregion
