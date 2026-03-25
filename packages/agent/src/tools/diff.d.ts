declare module 'diff' {
  interface Change {
    value: string;
    added?: boolean;
    removed?: boolean;
    count?: number;
  }

  function diffLines(oldStr: string, newStr: string): Change[];
}
