/**
 * Filesystem confinement — the boundary ACP puts on the client.
 *
 * These cover the lexical path logic; `client.test.ts` covers it end to end
 * over the wire, where an agent actually tries to escape.
 */

import { describe, expect, test } from 'bun:test';
import { isAbsolutePath, isWithinRoots, normalizePath } from '../src/paths';

describe('isAbsolutePath', () => {
  test('accepts POSIX absolute paths', () => {
    expect(isAbsolutePath('/workspace/a.ts')).toBe(true);
    expect(isAbsolutePath('/')).toBe(true);
  });

  test('accepts Windows absolute paths', () => {
    expect(isAbsolutePath('C:\\work\\a.ts')).toBe(true);
    expect(isAbsolutePath('c:/work/a.ts')).toBe(true);
  });

  test('rejects relative paths, which the spec forbids on the wire', () => {
    expect(isAbsolutePath('a.ts')).toBe(false);
    expect(isAbsolutePath('./a.ts')).toBe(false);
    expect(isAbsolutePath('../a.ts')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
  });
});

describe('normalizePath', () => {
  test('collapses redundant separators and dot segments', () => {
    expect(normalizePath('/a//b/./c')).toBe('/a/b/c');
  });

  test('resolves parent segments lexically', () => {
    expect(normalizePath('/a/b/../c')).toBe('/a/c');
    expect(normalizePath('/a/b/../../c')).toBe('/c');
  });

  test('cannot be walked above the root', () => {
    expect(normalizePath('/../../etc/passwd')).toBe('/etc/passwd');
    expect(normalizePath('/..')).toBe('/');
  });

  test('normalizes Windows separators and drive case', () => {
    expect(normalizePath('c:\\work\\..\\other')).toBe('C:/other');
  });

  test('a trailing slash does not change the path', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b');
  });
});

describe('isWithinRoots', () => {
  const ROOTS = [
    '/workspace',
  ];

  test('a file in the root is inside', () => {
    expect(isWithinRoots('/workspace/src/a.ts', ROOTS)).toBe(true);
  });

  test('the root itself is inside', () => {
    expect(isWithinRoots('/workspace', ROOTS)).toBe(true);
  });

  test('a sibling path outside is rejected', () => {
    expect(isWithinRoots('/etc/passwd', ROOTS)).toBe(false);
  });

  // The separator matters: a prefix match alone would let a sibling directory
  // whose name merely starts with the root's name slip through.
  test('a directory sharing the root as a name prefix is NOT inside', () => {
    expect(isWithinRoots('/workspace-secrets/keys', ROOTS)).toBe(false);
    expect(isWithinRoots('/workspaces/other', ROOTS)).toBe(false);
  });

  test('parent traversal out of the root is rejected', () => {
    expect(isWithinRoots('/workspace/../etc/passwd', ROOTS)).toBe(false);
    expect(isWithinRoots('/workspace/src/../../etc/passwd', ROOTS)).toBe(false);
  });

  test('traversal that lands back inside is allowed', () => {
    expect(isWithinRoots('/workspace/src/../lib/a.ts', ROOTS)).toBe(true);
  });

  test('any of several roots admits a path', () => {
    const roots = [
      '/workspace',
      '/cache',
    ];
    expect(isWithinRoots('/cache/x', roots)).toBe(true);
    expect(isWithinRoots('/other/x', roots)).toBe(false);
  });

  test('a root with a trailing slash behaves the same', () => {
    expect(
      isWithinRoots('/workspace/a.ts', [
        '/workspace/',
      ]),
    ).toBe(true);
    expect(
      isWithinRoots('/workspace-secrets/a.ts', [
        '/workspace/',
      ]),
    ).toBe(false);
  });

  test('no roots admits nothing', () => {
    expect(isWithinRoots('/anything', [])).toBe(false);
  });
});
