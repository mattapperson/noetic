/**
 * The connection entries a turn attaches (spec 35 § Attaching connections).
 * They live here, below both, because builders record a document's entries on
 * the step they build and the connection registry attaches them, and builders
 * must not import the registry.
 */

import type { ConnectionConfig } from '@noetic-tools/types';

//#region Types

/** An entry with its name settled. */
export interface NamedEntry {
  readonly name: string;
  readonly config: ConnectionConfig;
}

/** Where an attached entry lives: the turn's own `connections`, or a step's `tools`. */
export type AttachedScope = 'turn' | 'step';

/** An entry a turn attaches. */
export interface AttachedEntry extends NamedEntry {
  readonly scope: AttachedScope;
  /** Where it was given, for errors (`execute() connections`, `callModel('triage') tools`). */
  readonly where: string;
  /** A view layer renders its reads in the turn's context. */
  readonly viewed?: boolean;
}

//#endregion
