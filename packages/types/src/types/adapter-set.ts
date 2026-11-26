import { NoeticConfigError } from '../errors/noetic-config-error';

//#region Types

/** @public The name one unnamed adapter goes by. */
export const DEFAULT_ADAPTER_NAME = 'default';

/** @public One adapter of a named set, as an environment configures it. */
export interface NamedAdapter<A> {
  adapter: A;
  /** A name for people, where `name` is an id. */
  displayName?: string;
  /** What sets this adapter apart: the host it reaches, what it is for. */
  description?: string;
  /** Marks the adapter used when none is named. A set of several needs exactly one. */
  default?: boolean;
}

/** @public Several adapters of one kind, by name. */
export type NamedAdapters<A> = Readonly<Record<string, NamedAdapter<A>>>;

/** @public One adapter, or several by name. */
export type AdapterConfig<A> = A | NamedAdapters<A>;

/** @public One adapter of a set, as `AdapterSet.list()` reports it. */
export interface AdapterInfo {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly default: boolean;
}

/** @public A harness's adapters of one kind. */
export interface AdapterSet<A> {
  /**
   * The adapter called `name`, or the default without one.
   *
   * @throws `NoeticConfigError` `ADAPTER_UNKNOWN` when the set has no adapter of that name.
   */
  get(name?: string): A;
  /** Every adapter in the set, in the order the environment gave them. */
  list(): ReadonlyArray<AdapterInfo>;
}

//#endregion

//#region Public API

/**
 * @public
 * Builds an {@link AdapterSet} from what an environment configures. One
 * adapter goes by {@link DEFAULT_ADAPTER_NAME}.
 *
 * `method` is a method every adapter of this kind has. It tells an adapter
 * from a named set: a set's member of that name is an entry, never a function.
 *
 * @throws `NoeticConfigError` `ADAPTER_INVALID` for a value that is neither, or an entry with no adapter;
 * `ADAPTER_SET_EMPTY` for a set with no entries; `ADAPTER_DEFAULT_MISSING` for several with none marked
 * default; `ADAPTER_DEFAULT_AMBIGUOUS` for more than one marked.
 */
export function adapterSet<A extends object>(opts: {
  /** The environment key, as error messages name it: `fs`, `shell`, `subprocess`. */
  kind: string;
  config: AdapterConfig<A>;
  method: string;
}): AdapterSet<A> {
  const { kind, config, method } = opts;
  const isAdapter = (value: unknown): value is A =>
    typeof value === 'object' && value !== null && typeof Reflect.get(value, method) === 'function';
  if (isAdapter(config)) {
    return setOf(kind, [
      {
        name: DEFAULT_ADAPTER_NAME,
        adapter: config,
        default: true,
      },
    ]);
  }
  if (!isPlainObject(config)) {
    throw invalid(
      kind,
      `\`environment.${kind}\` is neither a ${kind} adapter (it has no \`${method}\` method) nor a set of named ones.`,
    );
  }
  const entries = namedEntries(kind, config, isAdapter);
  assertOneDefault(kind, entries);
  return setOf(kind, entries);
}

//#endregion

//#region Helpers

interface Entry<A> extends AdapterInfo {
  readonly adapter: A;
}

/** The entries of a named set, each checked to hold an adapter. A set of one is its own default. */
function namedEntries<A>(
  kind: string,
  config: Record<string, unknown>,
  isAdapter: (value: unknown) => value is A,
): Entry<A>[] {
  const names = Object.keys(config);
  if (names.length === 0) {
    throw new NoeticConfigError({
      code: 'ADAPTER_SET_EMPTY',
      message: `\`environment.${kind}\` names no adapters.`,
      hint: `Give it at least one \`{ adapter }\` entry, or leave \`${kind}\` out for the in-memory adapter.`,
    });
  }
  return names.map((name): Entry<A> => {
    const entry = config[name];
    const adapter = isPlainObject(entry) ? entry.adapter : undefined;
    if (!isPlainObject(entry) || !isAdapter(adapter)) {
      throw invalid(
        kind,
        `\`environment.${kind}.${name}\` has no ${kind} adapter under \`adapter\`.`,
      );
    }
    return {
      name,
      adapter,
      ...textOf(entry, 'displayName'),
      ...textOf(entry, 'description'),
      default: names.length === 1 || entry.default === true,
    };
  });
}

function assertOneDefault<A>(kind: string, entries: ReadonlyArray<Entry<A>>): void {
  const marked = entries.filter((entry) => entry.default).map((entry) => entry.name);
  if (marked.length === 0) {
    throw new NoeticConfigError({
      code: 'ADAPTER_DEFAULT_MISSING',
      message: `\`environment.${kind}\` names ${listed(entries.map((entry) => entry.name))} and marks none as the default.`,
      hint: 'Add `default: true` to the adapter that anything naming none should use.',
    });
  }
  if (marked.length > 1) {
    throw new NoeticConfigError({
      code: 'ADAPTER_DEFAULT_AMBIGUOUS',
      message: `\`environment.${kind}\` marks ${listed(marked)} as the default.`,
      hint: 'Leave `default: true` on one adapter only.',
    });
  }
}

/** A set over checked entries, exactly one of them the default. */
function setOf<A>(kind: string, entries: ReadonlyArray<Entry<A>>): AdapterSet<A> {
  const byName = new Map(
    entries.map((entry) => [
      entry.name,
      entry.adapter,
    ]),
  );
  const fallback = entries.find((entry) => entry.default)?.name ?? DEFAULT_ADAPTER_NAME;
  const infos = entries.map(({ adapter: _adapter, ...info }): AdapterInfo => info);
  return {
    get(name = fallback) {
      const adapter = byName.get(name);
      if (adapter === undefined) {
        throw new NoeticConfigError({
          code: 'ADAPTER_UNKNOWN',
          message: `No ${kind} adapter is named '${name}'. The harness has ${listed([
            ...byName.keys(),
          ])}.`,
          hint: `Use one of those names, or add '${name}' to \`environment.${kind}\`.`,
        });
      }
      return adapter;
    },
    list: () => infos,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Reflect.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function textOf(
  entry: Record<string, unknown>,
  key: 'displayName' | 'description',
): Partial<Record<typeof key, string>> {
  const value = entry[key];
  return typeof value === 'string'
    ? {
        [key]: value,
      }
    : {};
}

function listed(names: ReadonlyArray<string>): string {
  return names.map((name) => `'${name}'`).join(', ');
}

function invalid(kind: string, message: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'ADAPTER_INVALID',
    message,
    hint: `Give \`environment.${kind}\` one adapter, or \`{ <name>: { adapter, displayName?, description?, default? } }\`.`,
  });
}

//#endregion
