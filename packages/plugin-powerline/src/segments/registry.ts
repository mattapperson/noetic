import { gitSegment } from './git.js';
import { modelSegment } from './model.js';
import { noeticSegment } from './noetic.js';
import { pathSegment } from './path.js';
import { clockSegment, sessionTimeSegment } from './time.js';
import { contextPctSegment, tokensSegment } from './tokens.js';
import type { Segment } from './types.js';

export const SEGMENTS: Record<string, Segment> = {
  noetic: noeticSegment,
  model: modelSegment,
  path: pathSegment,
  git: gitSegment,
  tokens: tokensSegment,
  context_pct: contextPctSegment,
  session_time: sessionTimeSegment,
  clock: clockSegment,
};

export function resolveSegments(names: ReadonlyArray<string>): ReadonlyArray<Segment> {
  const out: Segment[] = [];
  for (const name of names) {
    const seg = SEGMENTS[name];
    if (seg) {
      out.push(seg);
    }
  }
  return out;
}
