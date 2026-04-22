declare module 'diff' {
  interface Change {
    value: string;
    added?: boolean;
    removed?: boolean;
    count?: number;
  }

  interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }

  interface StructuredPatch {
    index?: string;
    oldFileName?: string;
    newFileName?: string;
    oldHeader?: string;
    newHeader?: string;
    hunks: Hunk[];
  }

  function diffLines(oldStr: string, newStr: string): Change[];
  function parsePatch(uniDiff: string): StructuredPatch[];
}
