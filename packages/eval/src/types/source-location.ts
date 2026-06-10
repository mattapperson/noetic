/**
 * A position in a source file. When used for write-back, the position points
 * at the opening quote of a string literal.
 *
 * Both `line` and `column` are **1-based** package-wide: line 1 is the first
 * line of the file and column 1 is the first character of a line. AST
 * discovery (`discoverFieldsFromSource`), stack-trace capture
 * (`createAdapter`), and the source writer (`writeOptimizedValues`) all share
 * this convention.
 */
export interface SourceLocation {
  filePath: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}
