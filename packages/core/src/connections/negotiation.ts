/**
 * Negotiation (spec 35 § Negotiation). A handle's or manifest entry's
 * requirements are semver ranges for a profile — which imply its parents'
 * ranges (spec 36) — and its extensions, plus the optional operations, events
 * and senses derived from use. A profile's required parts are implied by its
 * version; only the parts it marks `required: false`, and parts it does not
 * define (extension operations), are listed explicitly.
 */

import type {
  AnyExtension,
  AnyProfile,
  ConnectionHandle,
  ConnectionManifest,
  ConnectionRequirement,
  ExtensionRange,
} from '@noetic-tools/types';
import { ConnectionUnsatisfiedError, satisfiesRange } from '@noetic-tools/types';

//#region Types

/** What a workflow uses of a connection, from its steps or nodes. */
export interface ConnectionUse {
  readonly operations?: ReadonlyArray<string>;
  readonly events?: ReadonlyArray<string>;
  readonly senses?: ReadonlyArray<string>;
}

//#endregion

//#region Helpers

function extensionRequirement(entry: AnyExtension | ExtensionRange): [
  string,
  string,
] {
  if (entry.kind === 'extension') {
    return [
      entry.id,
      entry.defaultRange,
    ];
  }
  return [
    entry.extension.id,
    entry.range,
  ];
}

function isOptionalOrForeign(
  parts: Readonly<
    Record<
      string,
      {
        readonly required?: boolean;
      }
    >
  >,
  name: string,
): boolean {
  const part = parts[name];
  return part === undefined || part.required === false;
}

function unique(values: ReadonlyArray<string>): string[] {
  return [
    ...new Set(values),
  ];
}

function checkProfiles(
  name: string,
  manifest: ConnectionManifest,
  required: Readonly<Record<string, string>>,
): void {
  for (const [profile, range] of Object.entries(required)) {
    const version = manifest.profiles[profile];
    if (version !== undefined && satisfiesRange(version, range)) {
      continue;
    }
    throw new ConnectionUnsatisfiedError({
      connection: name,
      missing: {
        kind: 'profile',
        profile,
        range,
      },
    });
  }
}

function checkExtensions(
  name: string,
  manifest: ConnectionManifest,
  required: Readonly<Record<string, string>>,
): void {
  for (const [extension, range] of Object.entries(required)) {
    const version = manifest.extensions[extension];
    if (version !== undefined && satisfiesRange(version, range)) {
      continue;
    }
    throw new ConnectionUnsatisfiedError({
      connection: name,
      missing: {
        kind: 'extension',
        extension,
        range,
      },
    });
  }
}

function checkParts(
  name: string,
  manifest: ConnectionManifest,
  requirement: ConnectionRequirement,
): void {
  for (const op of requirement.operations ?? []) {
    if (!manifest.operations[op]) {
      throw new ConnectionUnsatisfiedError({
        connection: name,
        missing: {
          kind: 'operation',
          op,
        },
      });
    }
  }
  for (const event of requirement.events ?? []) {
    if (!manifest.events[event]) {
      throw new ConnectionUnsatisfiedError({
        connection: name,
        missing: {
          kind: 'event',
          event,
        },
      });
    }
  }
  for (const sense of requirement.senses ?? []) {
    if (!manifest.senses[sense]) {
      throw new ConnectionUnsatisfiedError({
        connection: name,
        missing: {
          kind: 'sense',
          sense,
        },
      });
    }
  }
}

//#endregion

//#region Public API

/**
 * Checks `manifest` offers what `requirement` asks. `parents` are the parent
 * profile ranges the required profile implies (`profile.parents`).
 *
 * @throws ConnectionUnsatisfiedError (`CONNECTION_UNSATISFIED`) naming the first missing part.
 */
export function checkRequirement(
  name: string,
  manifest: ConnectionManifest,
  requirement: ConnectionRequirement & {
    readonly parents?: Readonly<Record<string, string>>;
  },
): void {
  const profiles: Record<string, string> = {};
  if (requirement.profile) {
    profiles[requirement.profile.name] = requirement.profile.range;
  }
  checkProfiles(name, manifest, profiles);
  checkProfiles(name, manifest, requirement.parents ?? {});
  checkExtensions(name, manifest, requirement.extensions ?? {});
  checkParts(name, manifest, requirement);
}

/**
 * The requirement a handle and its use add up to: the profile at the handle's
 * range, its extensions, and the operations, events and senses used that the
 * profile does not already require.
 */
export function requirementFor(
  handle: ConnectionHandle,
  use: ConnectionUse = {},
): ConnectionRequirement {
  const profile: AnyProfile | undefined = handle.profile;
  const extensions = Object.fromEntries(
    (handle.options.extensions ?? []).map(extensionRequirement),
  );
  const operations = unique(use.operations ?? []).filter(
    (op) => !profile || isOptionalOrForeign(profile.operations, op),
  );
  const events = unique(use.events ?? []).filter(
    (event) => !profile || isOptionalOrForeign(profile.events, event),
  );
  return {
    ...(profile
      ? {
          profile: {
            name: profile.name,
            range: handle.range ?? profile.defaultRange,
          },
        }
      : {}),
    ...(Object.keys(extensions).length > 0
      ? {
          extensions,
        }
      : {}),
    ...(operations.length > 0
      ? {
          operations,
        }
      : {}),
    ...(events.length > 0
      ? {
          events,
        }
      : {}),
    ...(use.senses && use.senses.length > 0
      ? {
          senses: unique(use.senses),
        }
      : {}),
  };
}

//#endregion
