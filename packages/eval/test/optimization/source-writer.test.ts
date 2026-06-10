import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { WriteBackEntry, WriteBackReport } from '../../src/optimization/source-writer';
import { writeOptimizedValues } from '../../src/optimization/source-writer';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-writer-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, {
    recursive: true,
    force: true,
  });
});

function tmpFile(name: string): string {
  return path.join(tmpDir, name);
}

// NOTE: SourceLocation columns are 1-based. In `const x = 'hello';` the
// opening quote is the 11th character, so column = 11.
const QUOTE_COLUMN = 11;

async function writeAndRead(
  filePath: string,
  content: string,
  entries: WriteBackEntry[],
): Promise<{
  result: string;
  report: WriteBackReport;
}> {
  await fs.writeFile(filePath, content, 'utf-8');
  const report = await writeOptimizedValues(entries);
  const result = await fs.readFile(filePath, 'utf-8');
  return {
    result,
    report,
  };
}

interface Position {
  line: number;
  column: number;
}

function entryAt(filePath: string, position: Position, newValue: string): WriteBackEntry {
  return {
    sourceLocation: {
      filePath,
      line: position.line,
      column: position.column,
    },
    newValue,
  };
}

async function importedX(filePath: string): Promise<unknown> {
  const mod = await import(filePath).then((m): unknown => m);
  if (typeof mod !== 'object' || mod === null) {
    throw new Error('imported module is not an object');
  }
  return Reflect.get(mod, 'x');
}

//#region Single-line Replacement

describe('single-line string replacement', () => {
  test('replaces single-quoted string', async () => {
    const fp = tmpFile('single.ts');
    const { result, report } = await writeAndRead(fp, "const x = 'hello world';", [
      entryAt(
        fp,
        {
          line: 1,
          column: QUOTE_COLUMN,
        },
        'goodbye world',
      ),
    ]);

    expect(result).toBe("const x = 'goodbye world';");
    expect(report.written).toBe(1);
    expect(report.skipped).toHaveLength(0);
  });

  test('replaces double-quoted string', async () => {
    const fp = tmpFile('double.ts');
    const { result } = await writeAndRead(fp, 'const x = "hello world";', [
      entryAt(
        fp,
        {
          line: 1,
          column: QUOTE_COLUMN,
        },
        'goodbye world',
      ),
    ]);

    expect(result).toBe('const x = "goodbye world";');
  });

  test('replaces single-line backtick string', async () => {
    const fp = tmpFile('backtick.ts');
    const { result } = await writeAndRead(fp, 'const x = `hello world`;', [
      entryAt(
        fp,
        {
          line: 1,
          column: QUOTE_COLUMN,
        },
        'goodbye world',
      ),
    ]);

    expect(result).toBe('const x = `goodbye world`;');
  });
});

//#endregion

//#region Multi-line Replacement

describe('multi-line template literal replacement', () => {
  test('replaces backtick string spanning multiple lines', async () => {
    const fp = tmpFile('multiline.ts');
    const content = [
      'const x = `line one',
      'line two',
      'line three`;',
    ].join('\n');
    const { result } = await writeAndRead(fp, content, [
      entryAt(
        fp,
        {
          line: 1,
          column: QUOTE_COLUMN,
        },
        'replaced',
      ),
    ]);

    expect(result).toBe('const x = `replaced`;');
  });
});

//#endregion

//#region Escaping

describe('escaped quotes within strings', () => {
  test('handles escaped single quotes in single-quoted string', async () => {
    const fp = tmpFile('escaped-single.ts');
    const { result } = await writeAndRead(fp, "const x = 'it\\'s a test';", [
      entryAt(
        fp,
        {
          line: 1,
          column: QUOTE_COLUMN,
        },
        'no escapes',
      ),
    ]);

    expect(result).toBe("const x = 'no escapes';");
  });

  test('handles escaped double quotes in double-quoted string', async () => {
    const fp = tmpFile('escaped-double.ts');
    const { result } = await writeAndRead(fp, 'const x = "say \\"hi\\"";', [
      entryAt(
        fp,
        {
          line: 1,
          column: QUOTE_COLUMN,
        },
        'done',
      ),
    ]);

    expect(result).toBe('const x = "done";');
  });

  test('escapes quotes in new value when replacing', async () => {
    const fp = tmpFile('escape-new.ts');
    const { result } = await writeAndRead(fp, "const x = 'old';", [
      entryAt(
        fp,
        {
          line: 1,
          column: QUOTE_COLUMN,
        },
        "it's new",
      ),
    ]);

    expect(result).toBe("const x = 'it\\'s new';");
  });

  test('escapes ${ in backtick strings — round-trips through import', async () => {
    const fp = tmpFile('escape-interp.ts');
    const newValue = [
      'Total: $',
      '{cost} for $',
      '{n} items',
    ].join('');
    await writeAndRead(fp, 'export const x = `old`;', [
      entryAt(
        fp,
        {
          line: 1,
          column: 18,
        },
        newValue,
      ),
    ]);

    expect(await importedX(fp)).toBe(newValue);
  });

  test('escapes newlines in single-quoted strings — round-trips through import', async () => {
    const fp = tmpFile('escape-newline.ts');
    const newValue = 'line one\nline two\r\nline three';
    const { result } = await writeAndRead(fp, "export const x = 'old';", [
      entryAt(
        fp,
        {
          line: 1,
          column: 18,
        },
        newValue,
      ),
    ]);

    // The literal must remain on a single source line.
    expect(result.split('\n')).toHaveLength(1);
    expect(await importedX(fp)).toBe(newValue);
  });

  test('escapes U+2028/U+2029 line separators in quoted strings', async () => {
    const fp = tmpFile('escape-ls.ts');
    const newValue = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
    await writeAndRead(fp, "export const x = 'old';", [
      entryAt(
        fp,
        {
          line: 1,
          column: 18,
        },
        newValue,
      ),
    ]);

    expect(await importedX(fp)).toBe(newValue);
  });

  test('escapes backslashes before quotes (ordering)', async () => {
    const fp = tmpFile('escape-order.ts');
    const newValue = "back\\slash and 'quote'";
    await writeAndRead(fp, "export const x = 'old';", [
      entryAt(
        fp,
        {
          line: 1,
          column: 18,
        },
        newValue,
      ),
    ]);

    expect(await importedX(fp)).toBe(newValue);
  });
});

//#endregion

//#region Multiple Replacements

describe('multiple replacements in same file', () => {
  test('replaces multiple strings bottom-up preserving offsets', async () => {
    const fp = tmpFile('multi.ts');
    const content = [
      "const a = 'first';",
      "const b = 'second';",
      "const c = 'third';",
    ].join('\n');
    const { result, report } = await writeAndRead(fp, content, [
      entryAt(
        fp,
        {
          line: 1,
          column: QUOTE_COLUMN,
        },
        'ONE',
      ),
      entryAt(
        fp,
        {
          line: 3,
          column: QUOTE_COLUMN,
        },
        'THREE',
      ),
    ]);

    const lines = result.split('\n');
    expect(lines[0]).toBe("const a = 'ONE';");
    expect(lines[1]).toBe("const b = 'second';");
    expect(lines[2]).toBe("const c = 'THREE';");
    expect(report.written).toBe(2);
  });

  test('two entries on the same line are both replaced (right-to-left)', async () => {
    const fp = tmpFile('same-line.ts');
    const content = "tool({ name: 'shortName', description: 'a much longer description' });";
    // Opening quotes: name at 0-based index 13 (column 14), description at index 39 (column 40).
    const { result, report } = await writeAndRead(fp, content, [
      entryAt(
        fp,
        {
          line: 1,
          column: 14,
        },
        'renamedToSomethingLonger',
      ),
      entryAt(
        fp,
        {
          line: 1,
          column: 40,
        },
        'new description',
      ),
    ]);

    expect(result).toBe(
      "tool({ name: 'renamedToSomethingLonger', description: 'new description' });",
    );
    expect(report.written).toBe(2);
    expect(report.skipped).toHaveLength(0);
  });
});

//#endregion

//#region Pre-write Validation

describe('pre-write validation', () => {
  test('throws when expectedValue does not match current value', async () => {
    const fp = tmpFile('validate.ts');
    await fs.writeFile(fp, "const x = 'actual';", 'utf-8');

    await expect(
      writeOptimizedValues([
        {
          sourceLocation: {
            filePath: fp,
            line: 1,
            column: QUOTE_COLUMN,
          },
          expectedValue: 'expected',
          newValue: 'new',
        },
      ]),
    ).rejects.toThrow('Source mismatch');
  });

  test('succeeds when expectedValue matches current value', async () => {
    const fp = tmpFile('validate-ok.ts');
    const { result } = await writeAndRead(fp, "const x = 'hello';", [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: QUOTE_COLUMN,
        },
        expectedValue: 'hello',
        newValue: 'goodbye',
      },
    ]);

    expect(result).toBe("const x = 'goodbye';");
  });

  test('throws with mismatch details for backtick strings', async () => {
    const fp = tmpFile('validate-bt.ts');
    await fs.writeFile(fp, 'const x = `actual`;', 'utf-8');

    await expect(
      writeOptimizedValues([
        {
          sourceLocation: {
            filePath: fp,
            line: 1,
            column: QUOTE_COLUMN,
          },
          expectedValue: 'expected',
          newValue: 'new',
        },
      ]),
    ).rejects.toThrow('Source mismatch');
  });
});

//#endregion

//#region Skip Reporting

describe('skip reporting for unusable locations', () => {
  test('reports skip when line is beyond file length; file untouched', async () => {
    const fp = tmpFile('oob-line.ts');
    const content = "const x = 'hello';";
    const { result, report } = await writeAndRead(fp, content, [
      entryAt(
        fp,
        {
          line: 999,
          column: 1,
        },
        'ignored',
      ),
    ]);

    expect(result).toBe(content);
    expect(report.written).toBe(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toContain('out of range');
    expect(report.skipped[0].sourceLocation.line).toBe(999);
  });

  test('reports skip when line is zero (below bounds)', async () => {
    const fp = tmpFile('oob-zero.ts');
    const content = "const x = 'hello';";
    const { result, report } = await writeAndRead(fp, content, [
      entryAt(
        fp,
        {
          line: 0,
          column: 1,
        },
        'ignored',
      ),
    ]);

    expect(result).toBe(content);
    expect(report.skipped).toHaveLength(1);
  });

  test('reports skip when column points to a letter', async () => {
    const fp = tmpFile('not-quote.ts');
    const content = "const x = 'hello';";
    const { result, report } = await writeAndRead(fp, content, [
      entryAt(
        fp,
        {
          line: 1,
          column: 1,
        },
        'ignored',
      ),
    ]);

    expect(result).toBe(content);
    expect(report.written).toBe(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toContain('no string literal');
  });

  test('column boundaries: exactly on the quote replaces; one off skips', async () => {
    const content = "const x = 'hello';";

    const onQuote = tmpFile('col-on.ts');
    const on = await writeAndRead(onQuote, content, [
      entryAt(
        onQuote,
        {
          line: 1,
          column: QUOTE_COLUMN,
        },
        'new',
      ),
    ]);
    expect(on.report.written).toBe(1);
    expect(on.result).toBe("const x = 'new';");

    const before = tmpFile('col-before.ts');
    const b = await writeAndRead(before, content, [
      entryAt(
        before,
        {
          line: 1,
          column: QUOTE_COLUMN - 1,
        },
        'new',
      ),
    ]);
    expect(b.report.written).toBe(0);
    expect(b.report.skipped).toHaveLength(1);
    expect(b.result).toBe(content);

    const after = tmpFile('col-after.ts');
    const a = await writeAndRead(after, content, [
      entryAt(
        after,
        {
          line: 1,
          column: QUOTE_COLUMN + 1,
        },
        'new',
      ),
    ]);
    expect(a.report.written).toBe(0);
    expect(a.report.skipped).toHaveLength(1);
    expect(a.result).toBe(content);
  });

  test('mixed batch: valid entries written, stale entries reported', async () => {
    const fp = tmpFile('mixed.ts');
    const content = [
      "const a = 'first';",
      "const b = 'second';",
    ].join('\n');
    const { result, report } = await writeAndRead(fp, content, [
      entryAt(
        fp,
        {
          line: 1,
          column: QUOTE_COLUMN,
        },
        'ONE',
      ),
      entryAt(
        fp,
        {
          line: 50,
          column: 1,
        },
        'ignored',
      ),
    ]);

    expect(result.split('\n')[0]).toBe("const a = 'ONE';");
    expect(report.written).toBe(1);
    expect(report.skipped).toHaveLength(1);
  });
});

//#endregion

//#region AST Discovery Integration

describe('AST discovery -> source writer round-trip', () => {
  test('writes back at AST-discovered locations (1-based column contract)', async () => {
    const agentPath = tmpFile('agent.ts');
    const evalPath = tmpFile('agent.eval.ts');
    await fs.writeFile(
      agentPath,
      [
        "import { step } from '@noetic-tools/core';",
        '',
        'export const agent = step.llm({',
        "  id: 'assistant',",
        "  model: 'openai/gpt-4o-mini',",
        "  instructions: 'You are a helpful assistant.',",
        '});',
        '',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(evalPath, "import { agent } from './agent';\nvoid agent;\n", 'utf-8');

    const { discoverFieldsFromSource } = await import(
      '../../src/static-analysis/ast-field-discovery'
    );
    const fields = discoverFieldsFromSource(evalPath);
    const instructionsField = fields.find((f) => f.path === 'assistant.instructions');
    expect(instructionsField).toBeDefined();
    if (!instructionsField?.sourceLocation) {
      throw new Error('expected sourceLocation on AST-discovered field');
    }

    const report = await writeOptimizedValues([
      {
        sourceLocation: instructionsField.sourceLocation,
        expectedValue: 'You are a helpful assistant.',
        newValue: 'You are a terse assistant.',
      },
    ]);

    expect(report.written).toBe(1);
    expect(report.skipped).toHaveLength(0);
    const updated = await fs.readFile(agentPath, 'utf-8');
    expect(updated).toContain("instructions: 'You are a terse assistant.',");
  });
});

//#endregion
