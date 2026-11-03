/**
 * Connection entries and their names (spec 35 § Attaching connections). An
 * entry is named by its record key, by its provider's `name`, or by both when
 * they agree. A name is the entry's identity: the same name in a scope and an
 * outer one (harness, then turn, then step) must carry the same provider and
 * options, or it is `CONNECTION_NAME_TAKEN`.
 */

import type { ConnectionConfig, ConnectionEntries, ConnectionEntry } from '@noetic-tools/types';
import { isConnectionProvider, normalizeConnectionEntry } from '@noetic-tools/types';
import type { NamedEntry } from '../types/connection-entry';
import { invalidConnectionError, nameTakenError } from './errors';
import { CONNECTION_NAME_PATTERN } from './handle';

//#region Helpers

const EXPOSE_VALUES = new Set([
  'eager',
  'all',
  'call',
  'none',
]);

const OPTION_KEYS = [
  'pool',
  'policy',
  'expose',
  'look',
] as const;

/** JSON with object keys sorted, so two equal option objects compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
      return inner;
    }
    return Object.fromEntries(
      Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

function namedFromKey(key: string, entry: ConnectionEntry, where: string): NamedEntry {
  const config = normalizeConnectionEntry(entry);
  const own = config.provider?.name;
  if (own !== undefined && own !== key) {
    throw invalidConnectionError(
      `${where} key '${key}' names a provider called '${own}'.`,
      `Use one name: the key '${key}' or mcp({ name: '${own}' }), or make them agree.`,
    );
  }
  return {
    name: key,
    config,
  };
}

//#endregion

//#region Public API

/** The name an entry carries on its provider, if any. */
export function entryName(entry: ConnectionEntry): string | undefined {
  return normalizeConnectionEntry(entry).provider?.name;
}

/**
 * Names every entry of a `connections` option and folds repeats of one entry.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for an unnamed list entry or a
 * record key its provider's name disagrees with; `CONNECTION_NAME_TAKEN` when
 * two entries share a name but not a provider and options.
 */
export function namedEntries(entries: ConnectionEntries | undefined, where: string): NamedEntry[] {
  if (entries === undefined) {
    return [];
  }
  const named = Array.isArray(entries)
    ? entries.map((entry) => namedFromList(entry, where))
    : Object.entries(entries).map(([key, entry]) => namedFromKey(key, entry, where));
  const byName = new Map<string, NamedEntry>();
  for (const entry of named) {
    const held = byName.get(entry.name);
    if (!held) {
      byName.set(entry.name, entry);
      continue;
    }
    if (!sameConfig(held.config, entry.config)) {
      throw nameTakenError(entry.name, where, where);
    }
  }
  return [
    ...byName.values(),
  ];
}

/**
 * Names one entry of a list: its provider's `name`.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when it has none.
 */
export function namedFromList(entry: ConnectionEntry, where: string): NamedEntry {
  const config = normalizeConnectionEntry(entry);
  const name = config.provider?.name;
  if (name === undefined) {
    throw invalidConnectionError(
      `${where} lists a connection with no name.`,
      "Name it on the provider (mcp({ name: 'linear', … })), or pass connections as a record keyed by name.",
    );
  }
  return {
    name,
    config,
  };
}

/**
 * Checks an entry before the registry holds it: a valid name, a provider, and a known `expose`.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for any of them.
 */
export function checkEntry(name: string, config: ConnectionConfig): void {
  if (!CONNECTION_NAME_PATTERN.test(name)) {
    throw invalidConnectionError(
      `Connection name '${name}' is not valid.`,
      'Start with a letter and use only letters, digits, _ and -.',
    );
  }
  if (!isConnectionProvider(config.provider)) {
    throw invalidConnectionError(
      `Connection '${name}' has no provider.`,
      'Pass mcp(…), a source, or any ConnectionProvider (an object with connect()).',
    );
  }
  if (config.expose !== undefined && !EXPOSE_VALUES.has(config.expose)) {
    throw invalidConnectionError(
      `Connection '${name}' has expose '${String(config.expose)}'.`,
      "Use expose: 'eager', 'all', 'call' or 'none'.",
    );
  }
}

/** Whether two entries are the same connection: one provider, equal options. */
export function sameConfig(a: ConnectionConfig, b: ConnectionConfig): boolean {
  if (a.provider !== b.provider) {
    return false;
  }
  return OPTION_KEYS.every((key) => stable(a[key]) === stable(b[key]));
}

//#endregion
