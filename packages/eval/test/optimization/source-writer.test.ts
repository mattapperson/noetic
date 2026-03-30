import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { WriteBackEntry } from '../../src/optimization/source-writer';
import { writeOptimizedValues } from '../../src/optimization/source-writer';

//#region Test Setup

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

async function writeAndRead(
  filePath: string,
  content: string,
  entries: WriteBackEntry[],
): Promise<string> {
  await fs.writeFile(filePath, content, 'utf-8');
  await writeOptimizedValues(entries);
  return fs.readFile(filePath, 'utf-8');
}

//#endregion

//#region Single-line String Replacement

describe('single-line string replacement', () => {
  test('replaces single-quoted string', async () => {
    const fp = tmpFile('single.ts');
    const content = "const x = 'hello world';";
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 10,
        },
        newValue: 'goodbye world',
      },
    ]);

    expect(result).toBe("const x = 'goodbye world';");
  });

  test('replaces double-quoted string', async () => {
    const fp = tmpFile('double.ts');
    const content = 'const x = "hello world";';
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 10,
        },
        newValue: 'goodbye world',
      },
    ]);

    expect(result).toBe('const x = "goodbye world";');
  });

  test('replaces single-line backtick string', async () => {
    const fp = tmpFile('backtick.ts');
    const content = 'const x = `hello world`;';
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 10,
        },
        newValue: 'goodbye world',
      },
    ]);

    expect(result).toBe('const x = `goodbye world`;');
  });
});

//#endregion

//#region Multi-line Template Literal

describe('multi-line template literal replacement', () => {
  test('replaces backtick string spanning multiple lines', async () => {
    const fp = tmpFile('multiline.ts');
    const content = [
      'const x = `line one',
      'line two',
      'line three`;',
    ].join('\n');
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 10,
        },
        newValue: 'replaced',
      },
    ]);

    expect(result).toBe('const x = `replaced`;');
  });
});

//#endregion

//#region Escaped Quotes

describe('escaped quotes within strings', () => {
  test('handles escaped single quotes in single-quoted string', async () => {
    const fp = tmpFile('escaped-single.ts');
    const content = "const x = 'it\\'s a test';";
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 10,
        },
        newValue: 'no escapes',
      },
    ]);

    expect(result).toBe("const x = 'no escapes';");
  });

  test('handles escaped double quotes in double-quoted string', async () => {
    const fp = tmpFile('escaped-double.ts');
    const content = 'const x = "say \\"hi\\"";';
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 10,
        },
        newValue: 'done',
      },
    ]);

    expect(result).toBe('const x = "done";');
  });

  test('escapes quotes in new value when replacing', async () => {
    const fp = tmpFile('escape-new.ts');
    const content = "const x = 'old';";
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 10,
        },
        newValue: "it's new",
      },
    ]);

    expect(result).toBe("const x = 'it\\'s new';");
  });
});

//#endregion

//#region Multiple Replacements (Bottom-Up Offset Preservation)

describe('multiple replacements in same file', () => {
  test('replaces multiple strings bottom-up preserving offsets', async () => {
    const fp = tmpFile('multi.ts');
    const content = [
      "const a = 'first';",
      "const b = 'second';",
      "const c = 'third';",
    ].join('\n');
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 10,
        },
        newValue: 'ONE',
      },
      {
        sourceLocation: {
          filePath: fp,
          line: 3,
          column: 10,
        },
        newValue: 'THREE',
      },
    ]);

    const lines = result.split('\n');
    expect(lines[0]).toBe("const a = 'ONE';");
    expect(lines[1]).toBe("const b = 'second';");
    expect(lines[2]).toBe("const c = 'THREE';");
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
            column: 10,
          },
          expectedValue: 'expected',
          newValue: 'new',
        },
      ]),
    ).rejects.toThrow('Source mismatch');
  });

  test('succeeds when expectedValue matches current value', async () => {
    const fp = tmpFile('validate-ok.ts');
    const content = "const x = 'hello';";
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 10,
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
            column: 10,
          },
          expectedValue: 'expected',
          newValue: 'new',
        },
      ]),
    ).rejects.toThrow('Source mismatch');
  });
});

//#endregion

//#region No-op Edge Cases

describe('no-op when location is out of bounds', () => {
  test('no-op when line is beyond file length', async () => {
    const fp = tmpFile('oob-line.ts');
    const content = "const x = 'hello';";
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 999,
          column: 0,
        },
        newValue: 'ignored',
      },
    ]);

    expect(result).toBe(content);
  });

  test('no-op when line is zero (below bounds)', async () => {
    const fp = tmpFile('oob-zero.ts');
    const content = "const x = 'hello';";
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 0,
          column: 0,
        },
        newValue: 'ignored',
      },
    ]);

    expect(result).toBe(content);
  });
});

describe('no-op when character at column is not a quote', () => {
  test('no-op when column points to a letter', async () => {
    const fp = tmpFile('not-quote.ts');
    const content = "const x = 'hello';";
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 0,
        },
        newValue: 'ignored',
      },
    ]);

    expect(result).toBe(content);
  });

  test('no-op when column points to whitespace', async () => {
    const fp = tmpFile('not-quote-ws.ts');
    const content = "const x = 'hello';";
    const result = await writeAndRead(fp, content, [
      {
        sourceLocation: {
          filePath: fp,
          line: 1,
          column: 9,
        },
        newValue: 'ignored',
      },
    ]);

    expect(result).toBe(content);
  });
});

//#endregion
