/**
 * `connection(name, profile?, options?)` (spec 35 § Steps): declares a
 * connection a workflow needs and returns a handle. With a profile, `op`,
 * `args` and outputs are typed by it, and the profile's range defaults to the
 * installed package's version (`^1.2.0`); `browser.range('^1.1')` overrides it.
 * The handle binds to the harness connection of the same name, or to
 * `options.from`.
 */

import type {
  AnyProfile,
  ConnectionFn,
  ConnectionHandle,
  ConnectionHandleOptions,
  ProfileRange,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { invalidConnectionError } from './errors';

//#region Constants

/** Connection names: a letter, then letters, digits, `_` and `-` (the same rule JSON manifests use). */
export const CONNECTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

//#endregion

//#region Helpers

function requireName(name: string, what: string): void {
  if (CONNECTION_NAME_PATTERN.test(name)) {
    return;
  }
  throw invalidConnectionError(
    `${what} '${name}' is not a valid connection name.`,
    'Start with a letter and use only letters, digits, _ and -.',
  );
}

function requireOptions(name: string, options: ConnectionHandleOptions): void {
  if (options.from !== undefined) {
    requireName(options.from, `connection('${name}') option from`);
  }
  if (options.fresh !== undefined && options.fresh !== 'run' && options.fresh !== 'path') {
    throw invalidConnectionError(
      `connection('${name}') has fresh '${String(options.fresh)}'.`,
      "Use fresh: 'run' (one per run) or fresh: 'path' (one per parallel path).",
    );
  }
  if (options.setup !== undefined && options.fresh === undefined) {
    throw invalidConnectionError(
      `connection('${name}') passes setup without fresh.`,
      "setup is given to a pool's provider; add fresh: 'run' or fresh: 'path'.",
    );
  }
}

function isProfileRange(value: AnyProfile | ProfileRange): value is ProfileRange {
  return value.kind === 'profile-range';
}

function makeHandle(
  name: string,
  profile: AnyProfile | ProfileRange | undefined,
  options: ConnectionHandleOptions = {},
): ConnectionHandle<AnyProfile | undefined> {
  requireName(name, 'connection()');
  requireOptions(name, options);
  if (!profile) {
    return {
      kind: 'connection-handle',
      name,
      profile: undefined,
      options,
    };
  }
  if (isProfileRange(profile)) {
    return {
      kind: 'connection-handle',
      name,
      profile: profile.profile,
      range: profile.range,
      options,
    };
  }
  return {
    kind: 'connection-handle',
    name,
    profile,
    range: profile.defaultRange,
    options,
  };
}

//#endregion

//#region Public API

/**
 * @public
 * Declares a connection a workflow needs and returns a handle steps use.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for a malformed name or options.
 */
export const connection: ConnectionFn = frameworkCast<ConnectionFn>(makeHandle);

/** @public Whether `value` is a handle `connection()` returned. */
export function isConnectionHandle(value: unknown): value is ConnectionHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'connection-handle'
  );
}

/** The harness connection (or pool) a handle binds to. */
export function handleTarget(handle: ConnectionHandle): string {
  return handle.options.from ?? handle.name;
}

//#endregion
