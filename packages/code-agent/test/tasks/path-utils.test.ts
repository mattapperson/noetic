import { describe, expect, it } from 'bun:test';

import { basename, dirname, format, join, parse, resolve } from '../../src/tasks/path-utils';

describe('path-utils.join', () => {
  it('joins simple segments with /', () => {
    expect(join('a', 'b', 'c')).toBe('a/b/c');
  });

  it('keeps a leading slash when the first segment is absolute', () => {
    expect(join('/repo', '.noetic', 'tasks')).toBe('/repo/.noetic/tasks');
  });

  it('absorbs leading slashes on later segments (POSIX join semantics)', () => {
    // Matches `node:path.posix.join` — `resolve` is the one that resets on absolute segments.
    expect(join('/a/b', '/c/d')).toBe('/a/b/c/d');
  });

  it('collapses duplicate slashes across segments', () => {
    expect(join('a/', '/b', '/c/')).toBe('a/b/c');
  });

  it('ignores empty pieces', () => {
    expect(join('a', '', 'b')).toBe('a/b');
  });

  it('returns . when nothing substantive remains', () => {
    expect(join()).toBe('.');
    expect(join('')).toBe('.');
  });
});

describe('path-utils.dirname', () => {
  it('returns the parent directory of a file path', () => {
    expect(dirname('/repo/.noetic/tasks/task.json')).toBe('/repo/.noetic/tasks');
  });

  it('returns / for top-level files', () => {
    expect(dirname('/foo')).toBe('/');
  });

  it('returns . for bare names', () => {
    expect(dirname('foo')).toBe('.');
  });

  it('trims a trailing slash before splitting', () => {
    expect(dirname('/repo/dir/')).toBe('/repo');
  });

  it('returns / for the root', () => {
    expect(dirname('/')).toBe('/');
  });
});

describe('path-utils.basename', () => {
  it('returns the last segment of a path', () => {
    expect(basename('/a/b/c.txt')).toBe('c.txt');
  });

  it('strips a provided extension', () => {
    expect(basename('/a/b/c.txt', '.txt')).toBe('c');
  });

  it('does not strip when the entire name equals the ext', () => {
    expect(basename('/a/b/.txt', '.txt')).toBe('.txt');
  });

  it('handles trailing slash', () => {
    expect(basename('/a/b/')).toBe('b');
  });
});

describe('path-utils.resolve', () => {
  it('joins absolute segments', () => {
    expect(resolve('/a', 'b', 'c')).toBe('/a/b/c');
  });

  it('folds . and ..', () => {
    expect(resolve('/a/b', '../c')).toBe('/a/c');
    expect(resolve('/a/b', './c')).toBe('/a/b/c');
  });

  it('returns / when everything is eaten by ..', () => {
    expect(resolve('/a', '..')).toBe('/');
    expect(resolve('/', '..')).toBe('/');
  });

  it('takes the last absolute segment as the new root', () => {
    expect(resolve('/a/b', '/c', 'd')).toBe('/c/d');
  });
});

describe('path-utils.parse', () => {
  it('splits a path into components', () => {
    expect(parse('/repo/.noetic/tasks/task.json')).toEqual({
      dir: '/repo/.noetic/tasks',
      root: '/',
      base: 'task.json',
      name: 'task',
      ext: '.json',
    });
  });

  it('handles bare filenames', () => {
    expect(parse('task.json')).toEqual({
      dir: '',
      root: '',
      base: 'task.json',
      name: 'task',
      ext: '.json',
    });
  });

  it('treats a leading dot as no extension', () => {
    expect(parse('.env')).toEqual({
      dir: '',
      root: '',
      base: '.env',
      name: '.env',
      ext: '',
    });
  });
});

describe('path-utils.format', () => {
  it('round-trips with parse', () => {
    const parsed = parse('/repo/.noetic/tasks/task.json');
    expect(format(parsed)).toBe('/repo/.noetic/tasks/task.json');
  });

  it('formats a name+ext inside a dir', () => {
    expect(
      format({
        dir: '/a/b',
        name: 'file',
        ext: '.txt',
      }),
    ).toBe('/a/b/file.txt');
  });

  it('formats root-relative paths', () => {
    expect(
      format({
        dir: '/',
        base: 'foo',
      }),
    ).toBe('/foo');
  });

  it('formats bare base when dir is empty', () => {
    expect(
      format({
        dir: '',
        base: 'file.txt',
      }),
    ).toBe('file.txt');
  });
});
