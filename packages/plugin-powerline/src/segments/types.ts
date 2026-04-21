import type { FooterContext } from '@noetic/cli';
import type { GitStatus } from '../git-status.js';
import type { IconSet } from '../icons.js';
import type { Theme } from '../theme.js';

export interface SegmentRenderArgs {
  ctx: FooterContext;
  theme: Theme;
  icons: IconSet;
  git: GitStatus | null;
  now: number;
}

export interface SegmentOutput {
  text: string;
  fg: string;
  bg: string;
  bold?: boolean;
}

export type Segment = (args: SegmentRenderArgs) => SegmentOutput | null;
