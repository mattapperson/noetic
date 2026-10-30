/**
 * Walking the values that cross a connection: arguments going out, outputs,
 * reads and event payloads coming in. Refs, blobs and secrets are found by
 * shape wherever they sit, so every walk here is structural.
 */

import type { JsonPath } from './json-schema';

//#region Types

/** One node a walk visits, with where it sits. */
export interface VisitedNode {
  readonly value: unknown;
  readonly path: JsonPath;
}

/** Returns a replacement for a node, or `undefined` to keep walking into it. */
export type NodeMapper = (node: VisitedNode) =>
  | {
      readonly replace: unknown;
    }
  | undefined;

//#endregion

//#region Helpers

const MAX_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function mapAt(node: VisitedNode, mapper: NodeMapper, depth: number): unknown {
  const mapped = mapper(node);
  if (mapped) {
    return mapped.replace;
  }
  if (depth >= MAX_DEPTH) {
    return node.value;
  }
  const { value, path } = node;
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      mapAt(
        {
          value: item,
          path: [
            ...path,
            i,
          ],
        },
        mapper,
        depth + 1,
      ),
    );
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = mapAt(
      {
        value: child,
        path: [
          ...path,
          key,
        ],
      },
      mapper,
      depth + 1,
    );
  }
  return out;
}

//#endregion

//#region Public API

/** Copies `value`, replacing every node `mapper` returns a replacement for. Class instances are kept as they are. */
export function mapDeep(value: unknown, mapper: NodeMapper): unknown {
  return mapAt(
    {
      value,
      path: [],
    },
    mapper,
    0,
  );
}

/** Every node `match` accepts, with its path. Matched nodes are not walked into. */
export function findDeep<T>(
  value: unknown,
  match: (node: unknown) => node is T,
): Array<{
  readonly value: T;
  readonly path: JsonPath;
}> {
  const found: Array<{
    value: T;
    path: JsonPath;
  }> = [];
  mapDeep(value, (node) => {
    if (!match(node.value)) {
      return undefined;
    }
    found.push({
      value: node.value,
      path: node.path,
    });
    return {
      replace: node.value,
    };
  });
  return found;
}

/** Replaces the node at `path` (which must exist) with `replacement`, copying along the way. */
export function setAtPath(value: unknown, path: JsonPath, replacement: unknown): unknown {
  return mapDeep(value, (node) => {
    if (node.path.length !== path.length) {
      return undefined;
    }
    const same = node.path.every((step, i) => step === path[i]);
    return same
      ? {
          replace: replacement,
        }
      : undefined;
  });
}

/** Whether `value` is a plain JSON-style object. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

//#endregion
