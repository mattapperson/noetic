import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ConnectionConfigErrorCode,
  configErrorDocsUrl,
  NoeticConfigError,
} from '@noetic-tools/types';
import { VerifyConfigErrorCode } from '@noetic-tools/types/verify';

//#region Helper Functions

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const ERRORS_DOC = join(REPO_ROOT, 'packages/web/content/docs/framework/errors.mdx');

/** The config-error code maps source may throw through (`code: VerifyConfigErrorCode.Invalid`). */
const CODE_MAPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ConnectionConfigErrorCode,
  VerifyConfigErrorCode,
};

/** The code `Map.Member` names; an unknown map or member is reported as unresolved so it cannot slip by. */
function mappedCode(map: string, member: string): string {
  return CODE_MAPS[map]?.[member] ?? `UNRESOLVED:${map}.${member}`;
}

/**
 * Every `code: 'X'` literal, and every `code: XConfigErrorCode.Member` constant,
 * in the source of every workspace package.
 */
function sourceCodes(): Set<string> {
  const codes = new Set<string>();
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir)) {
    for (const file of sourceFiles(join(packagesDir, pkg, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/code: '([A-Z0-9_]+)'/g)) {
        codes.add(match[1] ?? '');
      }
      for (const match of text.matchAll(/code: ([A-Za-z]+ConfigErrorCode)\.([A-Za-z]+)/g)) {
        codes.add(mappedCode(match[1] ?? '', match[2] ?? ''));
      }
    }
  }
  return codes;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, {
    recursive: true,
    encoding: 'utf8',
  })
    .filter((path) => path.endsWith('.ts'))
    .map((path) => join(dir, path));
}

/** The codes given a `#### CODE` section in the error reference. */
function documentedCodes(): Set<string> {
  const doc = readFileSync(ERRORS_DOC, 'utf8');
  return new Set(
    [
      ...doc.matchAll(/^#### ([A-Z0-9_]+)$/gm),
    ].map((match) => match[1] ?? ''),
  );
}

//#endregion

//#region Tests

describe('NoeticConfigError reference docs', () => {
  it('documents every config error code thrown in source', () => {
    const codes = sourceCodes();
    expect(codes.size).toBeGreaterThan(40);
    const documented = documentedCodes();
    const missing = [
      ...codes,
    ].filter((code) => !documented.has(code));
    expect(missing).toEqual([]);
  });

  it('documents no code that source no longer throws', () => {
    const codes = sourceCodes();
    const stale = [
      ...documentedCodes(),
    ].filter((code) => !codes.has(code));
    expect(stale).toEqual([]);
  });

  it("defaults docsUrl to the code's section of the reference", () => {
    const error = new NoeticConfigError({
      code: 'MISSING_API_KEY',
      message: 'Missing key.',
      hint: 'Set the key.',
    });
    expect(error.docsUrl).toBe('https://noetic.tools/docs/framework/errors#missing_api_key');
    expect(error.docsUrl).toBe(configErrorDocsUrl('MISSING_API_KEY'));
  });

  it('keeps an explicit docsUrl', () => {
    const error = new NoeticConfigError({
      code: 'MISSING_API_KEY',
      message: 'Missing key.',
      hint: 'Set the key.',
      docsUrl: 'https://example.com/keys',
    });
    expect(error.docsUrl).toBe('https://example.com/keys');
  });
});

//#endregion
