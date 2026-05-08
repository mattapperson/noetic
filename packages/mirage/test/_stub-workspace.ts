/**
 * Tiny in-memory `MirageWorkspace` stub used across the bridge tests.
 *
 * It understands just enough bash to exercise every path in
 * `createMirageFsAdapter` and `createMirageShellAdapter`:
 *   - `cat <path>` / `cat > <path>` / `cat >> <path>`
 *   - `base64 -d > <path>`
 *   - `mkdir -p <dir>`
 *   - `mv <old> <new>`
 *   - `rm [-rf] <path>`
 *   - `test -e <path>`
 *   - `stat [-L]c '%s %F' <path>`
 *   - `ls -1A <path>`
 *
 * The grammar is intentionally narrow — we parse exactly the commands
 * the bridge emits. Anything else returns exit 127 so the bridge's
 * `resource_op_unsupported` branch can be exercised in tests.
 */

import type { MirageExecuteOptions, MirageExecuteResult, MirageWorkspace } from '../src/types';

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

export function createStubWorkspace(opts: StubWorkspaceOpts = {}): StubWorkspace {
  const root: MemDir = {
    children: new Map(),
  };

  function splitPath(p: string): string[] {
    const abs = p.startsWith('/');
    const parts = p.split('/').filter((s) => s.length > 0);
    // Absolute flag is implicit — we only model an absolute VFS.
    if (!abs) {
      throw new Error(`stub workspace requires absolute paths; got ${p}`);
    }
    return parts;
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
    let cursor: MemDir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i];
      const child = cursor.children.get(name);
      if (!child) {
        if (!create) {
          return null;
        }
        const newDir: MemDir = {
          children: new Map(),
        };
        cursor.children.set(name, {
          kind: 'dir',
          dir: newDir,
        });
        cursor = newDir;
        continue;
      }
      if (child.kind !== 'dir') {
        if (!create) {
          return null;
        }
        throw new Error(`not a directory: /${parts.slice(0, i + 1).join('/')}`);
      }
      cursor = child.dir;
    }
    const leafName = parts[parts.length - 1];
    const existing = cursor.children.get(leafName);
    if (existing) {
      return existing;
    }
    if (!create) {
      return null;
    }
    if (kind === 'file') {
      const node: MemNode = {
        kind: 'file',
        file: {
          bytes: new Uint8Array(0),
        },
      };
      cursor.children.set(leafName, node);
      return node;
    }
    const node: MemNode = {
      kind: 'dir',
      dir: {
        children: new Map(),
      },
    };
    cursor.children.set(leafName, node);
    return node;
  }

  function getParent(
    parts: string[],
    createMissingDirs = false,
  ): {
    parent: MemDir;
    name: string;
  } | null {
    if (parts.length === 0) {
      return null;
    }
    const prefix = parts.slice(0, -1);
    if (prefix.length === 0) {
      return {
        parent: root,
        name: parts[0],
      };
    }
    if (createMissingDirs) {
      // Walk and materialise any missing directory segments.
      let cursor: MemDir = root;
      for (const seg of prefix) {
        const child = cursor.children.get(seg);
        if (!child) {
          const newDir: MemDir = {
            children: new Map(),
          };
          cursor.children.set(seg, {
            kind: 'dir',
            dir: newDir,
          });
          cursor = newDir;
          continue;
        }
        if (child.kind !== 'dir') {
          return null;
        }
        cursor = child.dir;
      }
      return {
        parent: cursor,
        name: parts[parts.length - 1],
      };
    }
    const node = resolve(prefix, false);
    if (!node || node.kind !== 'dir') {
      return null;
    }
    return {
      parent: node.dir,
      name: parts[parts.length - 1],
    };
  }

  interface WriteFileArgs {
    path: string;
    bytes: Uint8Array;
    append: boolean;
    createParents?: boolean;
  }

  function writeFile(args: WriteFileArgs): MirageExecuteResult {
    const { path, bytes, append, createParents = false } = args;
    const parts = splitPath(path);
    const parentInfo = getParent(parts, createParents);
    if (!parentInfo) {
      return err(`no such file or directory: ${path}`);
    }
    const { parent, name } = parentInfo;
    const existing = parent.children.get(name);
    if (existing && existing.kind !== 'file') {
      return err(`not a file: ${path}`);
    }
    if (append && existing) {
      const prev = existing.file.bytes;
      const next = new Uint8Array(prev.length + bytes.length);
      next.set(prev, 0);
      next.set(bytes, prev.length);
      existing.file.bytes = next;
    } else {
      parent.children.set(name, {
        kind: 'file',
        file: {
          bytes,
        },
      });
    }
    return ok();
  }

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

  function parseAndRun(command: string, stdin: string | undefined): MirageExecuteResult {
    // Match the exact forms the bridge emits. Paths are always
    // single-quoted per `shellQuote`, so strip quotes once extracted.
    const stripQ = (q: string): string =>
      q.startsWith("'") && q.endsWith("'") ? q.slice(1, -1).replace(/'\\''/g, "'") : q;

    // `cat '<path>'` (read)
    const catRead = command.match(/^cat '(.+)'$/s);
    if (catRead) {
      const path = stripQ(`'${catRead[1]}'`);
      const parts = splitPath(path);
      const node = resolve(parts, false);
      if (!node) {
        return err(`no such file: ${path}`);
      }
      if (node.kind !== 'file') {
        return err(`is a directory: ${path}`);
      }
      return ok(node.file.bytes);
    }

    // `cat > '<path>'` (write)
    const catWrite = command.match(/^cat > '(.+)'$/s);
    if (catWrite) {
      const path = stripQ(`'${catWrite[1]}'`);
      return writeFile({
        path,
        bytes: new TextEncoder().encode(stdin ?? ''),
        append: false,
      });
    }

    // `cat >> '<path>'` (append)
    const catAppend = command.match(/^cat >> '(.+)'$/s);
    if (catAppend) {
      const path = stripQ(`'${catAppend[1]}'`);
      return writeFile({
        path,
        bytes: new TextEncoder().encode(stdin ?? ''),
        append: true,
      });
    }

    // `base64 -d > '<path>'` (binary write)
    const base64Write = command.match(/^base64 -d > '(.+)'$/s);
    if (base64Write) {
      const path = stripQ(`'${base64Write[1]}'`);
      const bytes = Buffer.from(stdin ?? '', 'base64');
      return writeFile({
        path,
        bytes: new Uint8Array(bytes),
        append: false,
      });
    }

    // `mkdir -p '<path>'`
    const mkdir = command.match(/^mkdir -p '(.+)'$/s);
    if (mkdir) {
      const path = stripQ(`'${mkdir[1]}'`);
      resolve(splitPath(path), true, 'dir');
      return ok();
    }

    // `mv '<old>' '<new>'`
    const mv = command.match(/^mv '(.+)' '(.+)'$/s);
    if (mv) {
      const oldPath = stripQ(`'${mv[1]}'`);
      const newPath = stripQ(`'${mv[2]}'`);
      const srcInfo = getParent(splitPath(oldPath));
      if (!srcInfo) {
        return err(`no such file: ${oldPath}`);
      }
      const src = srcInfo.parent.children.get(srcInfo.name);
      if (!src) {
        return err(`no such file: ${oldPath}`);
      }
      const dstInfo = getParent(splitPath(newPath));
      if (!dstInfo) {
        return err(`no such directory for: ${newPath}`);
      }
      srcInfo.parent.children.delete(srcInfo.name);
      dstInfo.parent.children.set(dstInfo.name, src);
      return ok();
    }

    // `rm [-flags] '<path>'`
    const rm = command.match(/^rm( -[rf]+)? '(.+)'$/s);
    if (rm) {
      const path = stripQ(`'${rm[2]}'`);
      const recursive = rm[1]?.includes('r') ?? false;
      const force = rm[1]?.includes('f') ?? false;
      const info = getParent(splitPath(path));
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

    // `test -e '<path>'`
    const test = command.match(/^test -e '(.+)'$/s);
    if (test) {
      const path = stripQ(`'${test[1]}'`);
      const node = resolve(splitPath(path), false);
      return node ? ok() : err(`not found: ${path}`);
    }

    // `stat [-L]c '%s %F' '<path>'`
    const stat = command.match(/^stat -L?c '%s %F' '(.+)'$/s);
    if (stat) {
      const path = stripQ(`'${stat[1]}'`);
      const node = resolve(splitPath(path), false);
      if (!node) {
        return err(`no such file: ${path}`);
      }
      if (node.kind === 'file') {
        const size = node.file.bytes.length;
        const kind = size === 0 ? 'regular empty file' : 'regular file';
        return ok(`${size} ${kind}\n`);
      }
      return ok('0 directory\n');
    }

    // `ls -1A '<path>'`
    const ls = command.match(/^ls -1A '(.+)'$/s);
    if (ls) {
      const path = stripQ(`'${ls[1]}'`);
      const node = resolve(splitPath(path), false);
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

    // Intentionally unrecognised — exercises the "unsupported" branch.
    return unsupported(command.split(' ')[0] ?? command);
  }

  // Preload files — materialise parent directories on the way down.
  for (const [path, content] of Object.entries(opts.files ?? {})) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    writeFile({
      path,
      bytes,
      append: false,
      createParents: true,
    });
  }

  return {
    async execute(command: string, options?: MirageExecuteOptions): Promise<MirageExecuteResult> {
      return parseAndRun(command, options?.stdin);
    },
    peek(path: string): Uint8Array {
      const node = resolve(splitPath(path), false);
      if (!node || node.kind !== 'file') {
        throw new Error(`no such file: ${path}`);
      }
      return node.file.bytes;
    },
    has(path: string): boolean {
      return resolve(splitPath(path), false) !== null;
    },
  };
}
