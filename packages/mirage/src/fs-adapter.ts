import type { FsAdapter, FsStats } from '@noetic/core';
import { MirageError } from './errors';
import { shellQuote } from './path';
import type { MirageWorkspace } from './types';

//#region Helpers

interface RawResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number | null;
}

async function runCommand(
  workspace: MirageWorkspace,
  command: string,
  stdin?: string,
): Promise<RawResult> {
  return workspace.execute(command, {
    stdin,
  });
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Detect "this backend does not implement the op" vs generic I/O failure.
 *
 * Conservative matcher: we only classify as `resource_op_unsupported`
 * when the failure signal is unambiguous. The criteria are:
 *
 *   1. Exit code 127 — bash's universal "command not found." Mirage's
 *      executor emits this when a per-mount handler has no implementation
 *      for the requested command.
 *   2. Stderr contains `"command not found"` — same signal on stderr
 *      for non-127 shells.
 *   3. Stderr contains `"not implemented"` — explicit handler opt-out.
 *
 * We deliberately do NOT match bare `"not supported"` / `"operation not
 * supported"` substrings. Those appear in legitimate `io_failed` errors
 * like `chmod: not supported on this filesystem` or `nfs: operation not
 * supported by server` — the operation IS implemented, the backend is
 * just refusing this specific call. Mis-classifying those as "unsupported"
 * would cause consumers with fallback logic to retry on non-recoverable
 * errors.
 *
 * If you're a Mirage resource author and the conservative heuristic
 * misses your "unsupported" signal, emit exit 127 or include `"not
 * implemented"` in the stderr line.
 */
function looksUnsupported(result: RawResult, stderr: string): boolean {
  if (result.exitCode === 127) {
    return true;
  }
  const lower = stderr.toLowerCase();
  return lower.includes('command not found') || lower.includes('not implemented');
}

function throwIfNonZero(operation: string, path: string, result: RawResult): void {
  if (result.exitCode === 0) {
    return;
  }
  const stderr = decodeUtf8(result.stderr).trim();
  throw new MirageError({
    kind: looksUnsupported(result, stderr) ? 'resource_op_unsupported' : 'io_failed',
    operation,
    path,
    exitCode: result.exitCode,
    stderr,
  });
}

async function statRaw(
  workspace: MirageWorkspace,
  path: string,
  follow: boolean,
): Promise<FsStats> {
  const flag = follow ? '-Lc' : '-c';
  const command = `stat ${flag} '%s %F' ${shellQuote(path)}`;
  const result = await runCommand(workspace, command);
  throwIfNonZero('stat', path, result);
  const raw = decodeUtf8(result.stdout).trim();
  const [sizeStr, ...kindParts] = raw.split(' ');
  const kind = kindParts.join(' ');
  const size = Number.parseInt(sizeStr, 10) || 0;
  return {
    size,
    isFile: () => kind === 'regular file' || kind === 'regular empty file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symbolic link',
  };
}

//#endregion

//#region Public API

/**
 * Construct an `FsAdapter` backed by a Mirage `Workspace`. Every
 * operation dispatches through `workspace.execute` — Mirage's
 * tree-sitter bash executor routes the command to the correct
 * per-mount resource handler.
 *
 * This implementation is deliberately simple and correct over fast:
 * until Mirage publishes a direct file-level API surface, shelling
 * out per operation is the only contract we can rely on. When the
 * direct API lands upstream, the hot methods (`readFile`,
 * `writeFileBytes`, `stat`) switch to native calls without a
 * call-site change.
 *
 * Error shape: `io_failed` for generic non-zero exits, `resource_op_unsupported`
 * when the backend signals "command not found" or similar. Both
 * surface as `MirageError` instances — callers check `error.kind` to
 * distinguish.
 *
 * Binary safety: `writeFileBytes` round-trips through base64 because
 * the `workspace.execute({ stdin: string })` contract only preserves
 * ASCII-safe bytes. `readFile` returns a detached `Buffer` — the
 * Buffer must be unaffected by subsequent reads even if the backend
 * pools buffers across `execute` calls. On current Node and Bun,
 * `Buffer.from(Uint8Array)` already copies; the explicit `.slice()`
 * in the implementation is defense-in-depth for exotic runtimes
 * where `Buffer.from` might alias.
 *
 * @public
 */
export function createMirageFsAdapter(workspace: MirageWorkspace): FsAdapter {
  return {
    async readFile(path) {
      const result = await runCommand(workspace, `cat ${shellQuote(path)}`);
      throwIfNonZero('readFile', path, result);
      // Defensive copy via `.slice()` — the Buffer returned from
      // this read must not mutate when the workspace overwrites its
      // pooled `Uint8Array` on a subsequent call. Current Node / Bun
      // already copy via `Buffer.from`; the explicit slice locks the
      // invariant in place for exotic runtimes too.
      return Buffer.from(result.stdout.slice());
    },

    async readFileText(path) {
      const result = await runCommand(workspace, `cat ${shellQuote(path)}`);
      throwIfNonZero('readFileText', path, result);
      return decodeUtf8(result.stdout);
    },

    async writeFile(path, content) {
      const result = await runCommand(workspace, `cat > ${shellQuote(path)}`, content);
      throwIfNonZero('writeFile', path, result);
    },

    async writeFileBytes(path, content) {
      // stdin is typed as `string`; any non-UTF-8 bytes would be
      // corrupted by the text channel. Base64-encode so every byte
      // round-trips as ASCII, and decode on the remote side.
      const encoded = Buffer.from(content).toString('base64');
      const result = await runCommand(workspace, `base64 -d > ${shellQuote(path)}`, encoded);
      throwIfNonZero('writeFileBytes', path, result);
    },

    async appendFile(path, content) {
      const result = await runCommand(workspace, `cat >> ${shellQuote(path)}`, content);
      throwIfNonZero('appendFile', path, result);
    },

    async mkdir(dir) {
      const result = await runCommand(workspace, `mkdir -p ${shellQuote(dir)}`);
      throwIfNonZero('mkdir', dir, result);
    },

    async rename(oldPath, newPath) {
      const result = await runCommand(
        workspace,
        `mv ${shellQuote(oldPath)} ${shellQuote(newPath)}`,
      );
      throwIfNonZero('rename', `${oldPath} -> ${newPath}`, result);
    },

    async rm(path, options) {
      const flags: string[] = [];
      if (options?.recursive) {
        flags.push('-r');
      }
      if (options?.force) {
        flags.push('-f');
      }
      const flagStr = flags.length > 0 ? `${flags.join('')} ` : '';
      const result = await runCommand(workspace, `rm ${flagStr}${shellQuote(path)}`);
      if (options?.force && result.exitCode !== 0) {
        return;
      }
      throwIfNonZero('rm', path, result);
    },

    async access(path) {
      const result = await runCommand(workspace, `test -e ${shellQuote(path)}`);
      throwIfNonZero('access', path, result);
    },

    async stat(path) {
      return statRaw(workspace, path, true);
    },

    async lstat(path) {
      return statRaw(workspace, path, false);
    },

    async readdir(path) {
      const result = await runCommand(workspace, `ls -1A ${shellQuote(path)}`);
      throwIfNonZero('readdir', path, result);
      return decodeUtf8(result.stdout)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },
  };
}

//#endregion
