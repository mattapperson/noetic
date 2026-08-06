/**
 * Agent Plugins §4.1 — package path containment.
 *
 * Every file or directory a client reads out of a plugin package must, after
 * the filesystem has resolved it, still live inside the plugin root. Symlinks
 * are allowed to *point* somewhere else on disk as long as the target lands
 * back inside the root, which is exactly why lexical normalization alone is
 * not enough: `skills/evil` may be a symlink to `/etc`, and `path.resolve`
 * would happily report it as contained.
 *
 * So containment is decided on `realpath` output, and a path that cannot be
 * realpath'd (it does not exist, or a component is an unreadable symlink) is
 * treated as *not* contained. The check fails closed.
 */

import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

//#region Types

/** @public Outcome of resolving a package path against a plugin root. */
export type ContainmentResult =
  | {
      ok: true;
      /** The filesystem-resolved (realpath'd) absolute path. */
      path: string;
    }
  | {
      ok: false;
      reason: 'not-relative' | 'escapes-root' | 'unresolvable';
      /** The lexically resolved path, for diagnostics. Never trust it for I/O. */
      attempted: string;
    };

//#endregion

//#region Helpers

/**
 * True when `child` is `parent` or sits underneath it. Both arguments must
 * already be absolute and filesystem-resolved — this is a pure string check.
 */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) {
    return true;
  }
  // The separator suffix stops `/plugins/foo-evil` matching parent `/plugins/foo`.
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * Resolve a path through the filesystem, walking up to the nearest existing
 * ancestor when the leaf itself does not exist yet.
 *
 * A plain `realpath` throws on a missing leaf, which would make it impossible
 * to containment-check a path a client is about to *create* (a `PLUGIN_DATA`
 * subdirectory, for instance). Resolving the existing prefix and re-appending
 * the missing tail keeps the symlink guarantee — no existing component of the
 * path can redirect elsewhere — while still admitting not-yet-created leaves.
 */
async function resolveExistingPrefix(target: string): Promise<string | null> {
  const missing: string[] = [];
  let current = target;

  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) {
        // Walked to the filesystem root without finding anything readable.
        return null;
      }
      missing.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

//#endregion

//#region Public API

/**
 * True when `value` is a plugin-relative path as §4.1 defines one: it begins
 * with `./`. Bare names, absolute paths, and `../` prefixes are all rejected.
 *
 * @public
 */
export function isPluginRelativePath(value: string): boolean {
  return value.startsWith('./');
}

/**
 * Resolve a plugin-relative path (`./…`) against the plugin root and confirm
 * the filesystem-resolved result stays inside it (§4.1 rules 3 and 4).
 *
 * @public
 * @param pluginRoot - The filesystem-resolved absolute plugin root.
 * @param relative - A path that must begin with `./`.
 */
export async function resolvePluginRelative(
  pluginRoot: string,
  relative: string,
): Promise<ContainmentResult> {
  if (!isPluginRelativePath(relative)) {
    return {
      ok: false,
      reason: 'not-relative',
      attempted: relative,
    };
  }
  return containedPath(pluginRoot, resolve(pluginRoot, relative));
}

/**
 * Confirm an already-absolute path resolves inside `root`.
 *
 * Used for the fixed component locations (`skills/`, `mcp.json`), discovered
 * skill directories, and `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`-rooted values,
 * none of which arrive as `./` strings.
 *
 * @public
 */
export async function containedPath(root: string, target: string): Promise<ContainmentResult> {
  const attempted = isAbsolute(target) ? resolve(target) : resolve(root, target);
  // The root is resolved too. Comparing a realpath'd child against a root that
  // still contains a symlinked component reports a false escape — on macOS
  // every path under the system temp directory hits exactly that, since
  // `/var` is a symlink to `/private/var`.
  const realRoot = await resolveExistingPrefix(resolve(root));
  const real = await resolveExistingPrefix(attempted);
  if (realRoot === null || real === null) {
    return {
      ok: false,
      reason: 'unresolvable',
      attempted,
    };
  }
  if (!isWithin(realRoot, real)) {
    return {
      ok: false,
      reason: 'escapes-root',
      attempted,
    };
  }
  return {
    ok: true,
    path: real,
  };
}

/**
 * Resolve a plugin root directory itself. Returns `null` when the directory
 * cannot be resolved, which §4.1 rule 1 turns into "reject the plugin".
 *
 * @public
 */
export async function resolveRoot(dir: string): Promise<string | null> {
  try {
    return await realpath(resolve(dir));
  } catch {
    return null;
  }
}

//#endregion
