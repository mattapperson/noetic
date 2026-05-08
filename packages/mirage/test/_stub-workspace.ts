/**
 * Tiny in-memory `MirageWorkspace` stub used across the bridge tests.
 *
 * Understands just the bash forms the bridge emits:
 *   - `cat <path>` / `cat > <path>` / `cat >> <path>`
 *   - `base64 -d > <path>`
 *   - `mkdir -p <dir>`
 *   - `mv <old> <new>`
 *   - `rm [-rf] <path>`
 *   - `test -e <path>`
 *   - `stat [-L]c '%s %F' <path>`
 *   - `ls -1A <path>`
 *
 * Anything else returns exit 127 so the bridge's `resource_op_unsupported`
 * branch can be exercised. The parser is a handler registry: each entry
 * is a `{regex, run}` tuple; `parseAndRun` walks the list and dispatches
 * to the first match. This keeps the public factory trivial while the
 * parser lives as a small top-level function.
 */

import type { MirageExecuteOptions, MirageExecuteResult, MirageWorkspace } from '../src/types';

//#region Types

interface MemFile {
  bytes: Uint8Array;
}

interface MemDir {
  children: Map<string, MemNode>;
}

type MemNode =
  | {
      kind: 'file';
      file: MemFile;
    }
  | {
      kind: 'dir';
      dir: MemDir;
    };

interface ParentInfo {
  parent: MemDir;
  name: string;
}

interface StubFs {
  readonly root: MemDir;
  splitPath(p: string): string[];
  resolve(parts: string[], create: false): MemNode | null;
  resolve(parts: string[], create: true, kind: 'file' | 'dir'): MemNode;
  getParent(parts: string[], createMissingDirs?: boolean): ParentInfo | null;
  writeFile(args: WriteFileArgs): MirageExecuteResult;
}

interface WriteFileArgs {
  path: string;
  bytes: Uint8Array;
  append: boolean;
  createParents?: boolean;
}

type HandlerResult = MirageExecuteResult;
type Handler = (match: RegExpMatchArray, stdin: string | undefined, fs: StubFs) => HandlerResult;

interface HandlerEntry {
  readonly regex: RegExp;
  readonly run: Handler;
}

export interface StubWorkspaceOpts {
  /** Optional: preload files at construction. Keys are absolute paths. */
  files?: Record<string, string | Uint8Array>;
}

export interface StubWorkspace extends MirageWorkspace {
  /** Read the underlying bytes at a path. Throws if missing. */
  peek(path: string): Uint8Array;
  /** True if the path exists. */
  has(path: string): boolean;
}

//#endregion

//#region Pure result helpers

function ok(stdout: Uint8Array | string = ''): MirageExecuteResult {
  const out = typeof stdout === 'string' ? new TextEncoder().encode(stdout) : stdout;
  return {
    stdout: out,
    stderr: new Uint8Array(0),
    exitCode: 0,
  };
}

function err(msg: string, code = 1): MirageExecuteResult {
  return {
    stdout: new Uint8Array(0),
    stderr: new TextEncoder().encode(msg),
    exitCode: code,
  };
}

function unsupported(cmd: string): MirageExecuteResult {
  return err(`command not found: ${cmd}`, 127);
}

function stripQ(quoted: string): string {
  return quoted.startsWith("'") && quoted.endsWith("'")
    ? quoted.slice(1, -1).replace(/'\\''/g, "'")
    : quoted;
}

//#endregion

//#region Filesystem struct

function createStubFs(): StubFs {
  const root: MemDir = {
    children: new Map(),
  };

  function splitPath(p: string): string[] {
    if (!p.startsWith('/')) {
      throw new Error(`stub workspace requires absolute paths; got ${p}`);
    }
    return p.split('/').filter((s) => s.length > 0);
  }

  function resolve(parts: string[], create: false): MemNode | null;
  function resolve(parts: string[], create: true, kind: 'file' | 'dir'): MemNode;
  function resolve(parts: string[], create: boolean, kind?: 'file' | 'dir'): MemNode | null {
    if (parts.length === 0) {
      return {
        kind: 'dir',
        dir: root,
      };
    }
    const cursor = walkPrefix(parts.slice(0, -1), create);
    if (!cursor) {
      return null;
    }
    const leaf = parts[parts.length - 1];
    const existing = cursor.children.get(leaf);
    if (existing) {
      return existing;
    }
    if (!create) {
      return null;
    }
    const node: MemNode =
      kind === 'file'
        ? {
            kind: 'file',
            file: {
              bytes: new Uint8Array(0),
            },
          }
        : {
            kind: 'dir',
            dir: {
              children: new Map(),
            },
          };
    cursor.children.set(leaf, node);
    return node;
  }

  function walkPrefix(prefix: string[], create: boolean): MemDir | null {
    let cursor: MemDir = root;
    for (const seg of prefix) {
      const child = cursor.children.get(seg);
      if (child?.kind === 'dir') {
        cursor = child.dir;
        continue;
      }
      if (child) {
        return null;
      }
      if (!create) {
        return null;
      }
      const next: MemDir = {
        children: new Map(),
      };
      cursor.children.set(seg, {
        kind: 'dir',
        dir: next,
      });
      cursor = next;
    }
    return cursor;
  }

  function getParent(parts: string[], createMissingDirs = false): ParentInfo | null {
    if (parts.length === 0) {
      return null;
    }
    if (parts.length === 1) {
      return {
        parent: root,
        name: parts[0],
      };
    }
    const cursor = walkPrefix(parts.slice(0, -1), createMissingDirs);
    if (!cursor) {
      return null;
    }
    return {
      parent: cursor,
      name: parts[parts.length - 1],
    };
  }

  function writeFile(args: WriteFileArgs): MirageExecuteResult {
    const { path, bytes, append, createParents = false } = args;
    const info = getParent(splitPath(path), createParents);
    if (!info) {
      return err(`no such file or directory: ${path}`);
    }
    const existing = info.parent.children.get(info.name);
    if (existing && existing.kind !== 'file') {
      return err(`not a file: ${path}`);
    }
    if (append && existing) {
      const prev = existing.file.bytes;
      const next = new Uint8Array(prev.length + bytes.length);
      next.set(prev, 0);
      next.set(bytes, prev.length);
      existing.file.bytes = next;
      return ok();
    }
    info.parent.children.set(info.name, {
      kind: 'file',
      file: {
        bytes,
      },
    });
    return ok();
  }

  return {
    root,
    splitPath,
    resolve,
    getParent,
    writeFile,
  };
}

//#endregion

//#region Handler registry

const handlers: HandlerEntry[] = [
  {
    regex: /^cat '(.+)'$/s,
    run: handleCatRead,
  },
  {
    regex: /^cat > '(.+)'$/s,
    run: handleCatWrite,
  },
  {
    regex: /^cat >> '(.+)'$/s,
    run: handleCatAppend,
  },
  {
    regex: /^base64 -d > '(.+)'$/s,
    run: handleBase64Write,
  },
  {
    regex: /^mkdir -p '(.+)'$/s,
    run: handleMkdir,
  },
  {
    regex: /^mv '(.+)' '(.+)'$/s,
    run: handleMv,
  },
  {
    regex: /^rm( -[rf]+)? '(.+)'$/s,
    run: handleRm,
  },
  {
    regex: /^test -e '(.+)'$/s,
    run: handleTest,
  },
  {
    regex: /^stat -L?c '%s %F' '(.+)'$/s,
    run: handleStat,
  },
  {
    regex: /^ls -1A '(.+)'$/s,
    run: handleLs,
  },
];

function handleCatRead(
  match: RegExpMatchArray,
  _stdin: string | undefined,
  fs: StubFs,
): HandlerResult {
  const path = stripQ(`'${match[1]}'`);
  const node = fs.resolve(fs.splitPath(path), false);
  if (!node) {
    return err(`no such file: ${path}`);
  }
  if (node.kind !== 'file') {
    return err(`is a directory: ${path}`);
  }
  return ok(node.file.bytes);
}

function handleCatWrite(
  match: RegExpMatchArray,
  stdin: string | undefined,
  fs: StubFs,
): HandlerResult {
  const path = stripQ(`'${match[1]}'`);
  return fs.writeFile({
    path,
    bytes: new TextEncoder().encode(stdin ?? ''),
    append: false,
  });
}

function handleCatAppend(
  match: RegExpMatchArray,
  stdin: string | undefined,
  fs: StubFs,
): HandlerResult {
  const path = stripQ(`'${match[1]}'`);
  return fs.writeFile({
    path,
    bytes: new TextEncoder().encode(stdin ?? ''),
    append: true,
  });
}

function handleBase64Write(
  match: RegExpMatchArray,
  stdin: string | undefined,
  fs: StubFs,
): HandlerResult {
  const path = stripQ(`'${match[1]}'`);
  const bytes = new Uint8Array(Buffer.from(stdin ?? '', 'base64'));
  return fs.writeFile({
    path,
    bytes,
    append: false,
  });
}

function handleMkdir(
  match: RegExpMatchArray,
  _stdin: string | undefined,
  fs: StubFs,
): HandlerResult {
  const path = stripQ(`'${match[1]}'`);
  fs.resolve(fs.splitPath(path), true, 'dir');
  return ok();
}

function handleMv(match: RegExpMatchArray, _stdin: string | undefined, fs: StubFs): HandlerResult {
  const oldPath = stripQ(`'${match[1]}'`);
  const newPath = stripQ(`'${match[2]}'`);
  const srcInfo = fs.getParent(fs.splitPath(oldPath));
  if (!srcInfo) {
    return err(`no such file: ${oldPath}`);
  }
  const src = srcInfo.parent.children.get(srcInfo.name);
  if (!src) {
    return err(`no such file: ${oldPath}`);
  }
  const dstInfo = fs.getParent(fs.splitPath(newPath));
  if (!dstInfo) {
    return err(`no such directory for: ${newPath}`);
  }
  srcInfo.parent.children.delete(srcInfo.name);
  dstInfo.parent.children.set(dstInfo.name, src);
  return ok();
}

function handleRm(match: RegExpMatchArray, _stdin: string | undefined, fs: StubFs): HandlerResult {
  const path = stripQ(`'${match[2]}'`);
  const recursive = match[1]?.includes('r') ?? false;
  const force = match[1]?.includes('f') ?? false;
  const info = fs.getParent(fs.splitPath(path));
  if (!info) {
    return force ? ok() : err(`no such file: ${path}`);
  }
  const node = info.parent.children.get(info.name);
  if (!node) {
    return force ? ok() : err(`no such file: ${path}`);
  }
  if (node.kind === 'dir' && node.dir.children.size > 0 && !recursive) {
    return err(`directory not empty: ${path}`);
  }
  info.parent.children.delete(info.name);
  return ok();
}

function handleTest(
  match: RegExpMatchArray,
  _stdin: string | undefined,
  fs: StubFs,
): HandlerResult {
  const path = stripQ(`'${match[1]}'`);
  const node = fs.resolve(fs.splitPath(path), false);
  return node ? ok() : err(`not found: ${path}`);
}

function handleStat(
  match: RegExpMatchArray,
  _stdin: string | undefined,
  fs: StubFs,
): HandlerResult {
  const path = stripQ(`'${match[1]}'`);
  const node = fs.resolve(fs.splitPath(path), false);
  if (!node) {
    return err(`no such file: ${path}`);
  }
  if (node.kind !== 'file') {
    return ok('0 directory\n');
  }
  const size = node.file.bytes.length;
  const kind = size === 0 ? 'regular empty file' : 'regular file';
  return ok(`${size} ${kind}\n`);
}

function handleLs(match: RegExpMatchArray, _stdin: string | undefined, fs: StubFs): HandlerResult {
  const path = stripQ(`'${match[1]}'`);
  const node = fs.resolve(fs.splitPath(path), false);
  if (!node) {
    return err(`no such directory: ${path}`);
  }
  if (node.kind !== 'dir') {
    return err(`not a directory: ${path}`);
  }
  const names = [
    ...node.dir.children.keys(),
  ];
  return ok(names.length > 0 ? `${names.join('\n')}\n` : '');
}

function parseAndRun(command: string, stdin: string | undefined, fs: StubFs): MirageExecuteResult {
  for (const { regex, run } of handlers) {
    const match = command.match(regex);
    if (match) {
      return run(match, stdin, fs);
    }
  }
  return unsupported(command.split(' ')[0] ?? command);
}

//#endregion

//#region Public factory

export function createStubWorkspace(opts: StubWorkspaceOpts = {}): StubWorkspace {
  const fs = createStubFs();

  for (const [path, content] of Object.entries(opts.files ?? {})) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    fs.writeFile({
      path,
      bytes,
      append: false,
      createParents: true,
    });
  }

  return {
    async execute(command: string, options?: MirageExecuteOptions): Promise<MirageExecuteResult> {
      return parseAndRun(command, options?.stdin, fs);
    },
    peek(path: string): Uint8Array {
      const node = fs.resolve(fs.splitPath(path), false);
      if (!node || node.kind !== 'file') {
        throw new Error(`no such file: ${path}`);
      }
      return node.file.bytes;
    },
    has(path: string): boolean {
      return fs.resolve(fs.splitPath(path), false) !== null;
    },
  };
}

//#endregion
