import { gitSegment } from './git.js';
import { modelSegment } from './model.js';
import { noeticSegment } from './noetic.js';
import { pathSegment } from './path.js';
import { clockSegment, sessionTimeSegment } from './time.js';
import { contextPctSegment, tokensSegment } from './tokens.js';
import type { Segment } from './types.js';

export const SEGMENTS = {
  noetic: noeticSegment,
  model: modelSegment,
  path: pathSegment,
  git: gitSegment,
  tokens: tokensSegment,
  context_pct: contextPctSegment,
  session_time: sessionTimeSegment,
  clock: clockSegment,
} as const satisfies Record<string, Segment>;

export type SegmentName = keyof typeof SEGMENTS;

export interface ResolvedSegment {
  readonly name: SegmentName;
  readonly render: Segment;
}

function isSegmentName(name: string): name is SegmentName {
  return name in SEGMENTS;
}

export function resolveSegments(names: ReadonlyArray<string>): ReadonlyArray<ResolvedSegment> {
  const out: ResolvedSegment[] = [];
  for (const name of names) {
    if (!isSegmentName(name)) {
      continue;
    }
    out.push({
      name,
      render: SEGMENTS[name],
    });
  }
  return out;
}
