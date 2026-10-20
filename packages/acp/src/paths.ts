/**
 * Confining an agent's filesystem access to the workspace.
 *
 * ACP puts boundary enforcement on the **client**: the agent asks for a path
 * and the client decides whether it may have it. Nothing in the protocol
 * constrains what it asks for, and a `permissions` policy does not help — that
 * answers `session/request_permission`, which covers the agent's *tool calls*,
 * not the `fs/*` methods it invokes on us directly. An agent that simply never
 * asks is never gated by it.
 *
 * So the confinement has to live here. By default an agent reaches the session
 * working directory and nothing else; `additionalDirectories` widens that, and
 * `allowAnyPath` removes it for callers who genuinely want an unconfined agent.
 *
 * Path handling is deliberately lexical — no `node:path`, no symlink
 * resolution — so this module stays runtime-neutral. See
 * {@link isWithinRoots} for what that does and does not stop.
 */

//#region Absolute paths

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * The specification requires every path an agent sends to be absolute. A
 * relative path is therefore malformed input, not something to resolve against
 * a guessed base.
 * @public
 */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || WINDOWS_ABSOLUTE.test(path);
}

//#endregion

//#region Normalization

/**
 * Collapse `.`, `..`, duplicate separators, and backslashes into a canonical
 * form. Lexical only: `..` is resolved by removing the preceding segment
 * rather than by asking the filesystem, so it cannot be walked past the root.
 * @public
 */
export function normalizePath(path: string): string {
  const windowsRoot = WINDOWS_ABSOLUTE.test(path) ? path.slice(0, 2).toUpperCase() : '';
  const body = windowsRoot ? path.slice(2) : path;
  const segments: string[] = [];
  for (const segment of body.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      // Popping at the root is a no-op, so `/../../etc` normalizes to `/etc`
      // rather than escaping above it.
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${windowsRoot}/${segments.join('/')}`;
}

//#endregion

//#region Confinement

/**
 * True when `path` is inside one of `roots` (or is a root itself).
 *
 * **What this stops:** absolute paths outside the workspace, and `..` traversal
 * out of it, including forms like `/work/../../etc/passwd`.
 *
 * **What it does not stop:** a symlink *inside* the workspace pointing outside
 * it. Resolving that needs the filesystem, which this module deliberately does
 * not touch; a caller who needs it should supply an `FsAdapter` that resolves
 * and re-checks. Nor does it constrain what a terminal command does once
 * running — see the note on terminals in the ACP docs.
 * @public
 */
export function isWithinRoots(path: string, roots: ReadonlyArray<string>): boolean {
  const target = normalizePath(path);
  return roots.some((root) => {
    const normalized = normalizePath(root);
    if (target === normalized) {
      return true;
    }
    // The separator matters: `/workspace-secrets` must not count as inside
    // `/workspace`.
    const prefix = normalized.endsWith('/') ? normalized : `${normalized}/`;
    return target.startsWith(prefix);
  });
}

//#endregion
