import { describe, expect, it } from 'bun:test';

import { fileUrlToPath } from '../../src/tasks/file-url-to-path';

describe('fileUrlToPath', () => {
  it('decodes a POSIX file URL', () => {
    expect(fileUrlToPath('file:///repo/.noetic/runner.ts')).toBe('/repo/.noetic/runner.ts');
  });

  it('handles percent-encoded segments', () => {
    expect(fileUrlToPath('file:///a/b%20c/runner.ts')).toBe('/a/b c/runner.ts');
  });

  it('strips the leading slash on a Windows drive URL', () => {
    expect(fileUrlToPath('file:///C:/repo/runner.ts')).toBe('C:/repo/runner.ts');
  });

  it('falls back to href for non-file URLs', () => {
    expect(fileUrlToPath('https://example.com/a.ts')).toBe('https://example.com/a.ts');
  });

  it('accepts URL instances', () => {
    expect(fileUrlToPath(new URL('file:///tmp/x.ts'))).toBe('/tmp/x.ts');
  });
});
