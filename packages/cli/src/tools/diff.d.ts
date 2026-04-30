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

  interface PatchOptions {
    context?: number;
    ignoreWhitespace?: boolean;
    ignoreCase?: boolean;
    newlineIsToken?: boolean;
  }

  function diffLines(oldStr: string, newStr: string): Change[];
  function parsePatch(uniDiff: string): StructuredPatch[];
  function createPatch(
    fileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: PatchOptions,
  ): string;
  function createTwoFilesPatch(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: PatchOptions,
  ): string;
}
