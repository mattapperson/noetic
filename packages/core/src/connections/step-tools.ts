/**
 * What a model step is offered of a turn's connection tools (spec 35 § Step
 * tools). Every model call sends the turn's whole tool set and narrows it by
 * name, so a step's `tools` decide what it may run:
 *
 * - With no `tools`, a step is offered every tool except those of connections
 *   only some step listed.
 * - A step that lists a connection entry is offered that connection's tools;
 *   one that lists a `ConnectionPick` is offered the ones matching its `ops`.
 *
 * Each tool is cut to what the step may use, so a merged `ui_tap`, `ops` or
 * `call` reaches only the connections the step lists and a `<name>_call` only
 * the operations and reads it picked. A cut tool keeps its name and stands in
 * the step's request in place of the turn's.
 */

import type {
  ConnectionPick,
  Context,
  ServerToolSpec,
  StepToolEntry,
  Tool,
} from '@noetic-tools/types';
import { isConnectionEntry, isConnectionPick, isServerToolSpec } from '@noetic-tools/types';
import type { NamedEntry } from '../types/connection-entry';
import { rootOf } from '../util/root-context';
import { namedFromList, sameConfig } from './entries';
import { invalidConnectionError } from './errors';
import { matchesAnyGlob } from './glob';
import type { StepAllows } from './model-tools';
import { cutForStep, runtimeOf } from './model-tools';
import type { ConnectionRuntime } from './registry';

//#region Types

/** A turn's connections, as a step sees them. */
export interface StepConnections {
  readonly runtime: ConnectionRuntime;
  readonly rootId: string;
}

/** A step's `tools`, split by kind. */
export interface SplitStepTools {
  readonly tools: Tool[];
  readonly serverTools: ServerToolSpec[];
  /** The connections it lists: entries (no `ops`) and picks. */
  readonly picks: ConnectionPick[];
  /**
   * The picks are a ceiling, not a list: a document node with no `tools` may
   * reach only these connections, and keeps every other tool a step with no
   * `tools` is offered.
   */
  readonly ceiling?: true;
}

//#endregion

//#region Public API

/** The turn's connections, as a step's context sees them; undefined when the harness has no registry. */
export function stepConnectionsOf(ctx: Context): StepConnections | undefined {
  const runtime = runtimeOf(ctx.harness);
  if (!runtime) {
    return undefined;
  }
  return {
    runtime,
    rootId: rootOf(ctx).id,
  };
}

/** Splits a step's `tools` into client tools, server tools and connection picks. */
export function splitStepTools(entries: ReadonlyArray<StepToolEntry>): SplitStepTools {
  const split: SplitStepTools = {
    tools: [],
    serverTools: [],
    picks: [],
  };
  for (const entry of entries) {
    if (isServerToolSpec(entry)) {
      split.serverTools.push(entry);
      continue;
    }
    if (isConnectionPick(entry)) {
      split.picks.push(entry);
      continue;
    }
    if (isConnectionEntry(entry)) {
      split.picks.push(pickOfEntry(namedFromList(entry, 'A step')));
      continue;
    }
    split.tools.push(entry);
  }
  return split;
}

/**
 * The tools of `unified` a step offers, each connection tool cut to what the
 * step may use. Returns undefined for a step with no `tools` when nothing
 * needs holding back, so its call stays unrestricted.
 */
export function offeredTools(
  unified: ReadonlyArray<Tool>,
  listed: SplitStepTools | undefined,
  turn: StepConnections | undefined,
): Tool[] | undefined {
  const allows = listed ? pickedBy(listed.picks) : sharedIn(turn);
  const names =
    listed && !listed.ceiling ? new Set(listed.tools.map((tool) => tool.name)) : undefined;
  const offered = unified.flatMap((tool) => {
    const cut = cutForStep(tool, allows);
    if (cut === 'not-connection') {
      return !names || names.has(tool.name)
        ? [
            tool,
          ]
        : [];
    }
    return cut
      ? [
          cut,
        ]
      : [];
  });
  const whole = offered.length === unified.length && offered.every((t, i) => t === unified[i]);
  return (!listed || listed.ceiling) && whole ? undefined : offered;
}

/**
 * The tool set a step's request sends: the turn's, with each tool the step
 * was offered cut standing in its place.
 */
export function withOffered(
  unified: ReadonlyArray<Tool>,
  offered: ReadonlyArray<Tool> | undefined,
): Tool[] {
  const byName = new Map(
    (offered ?? []).map((tool) => [
      tool.name,
      tool,
    ]),
  );
  return unified.map((tool) => byName.get(tool.name) ?? tool);
}

/**
 * Checks the entries a function-form `tools` returned: each must name a
 * connection the harness or the turn already attached, with the same provider
 * and options, because the walk that connects step entries cannot see inside
 * a function.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for an entry nothing attached.
 */
export function checkLazyEntries(
  stepId: string,
  listed: ReadonlyArray<StepToolEntry>,
  turn: StepConnections | undefined,
): void {
  for (const raw of listed) {
    const entry = isConnectionPick(raw) ? raw.entry : isConnectionEntry(raw) ? raw : undefined;
    if (entry === undefined) {
      continue;
    }
    const named = namedFromList(entry, `callModel('${stepId}') tools`);
    const held = turn?.runtime.config(named.name, turn.rootId);
    const scope = turn?.runtime.scopeOf(named.name, turn.rootId);
    if (held && scope !== 'step' && sameConfig(held, named.config)) {
      continue;
    }
    throw invalidConnectionError(
      `callModel('${stepId}') returns connection '${named.name}' from a function-form tools, which the turn never connected.`,
      'Connections in a tools function must already be attached: move the entry to new AgentHarness({ connections }) or execute(input, { connections }), or list it in an eager tools array.',
    );
  }
}

//#endregion

//#region Helpers

function pickOfEntry(named: NamedEntry): ConnectionPick {
  return {
    kind: 'connection-pick',
    connection: named.name,
  };
}

/** What a step that lists `picks` may use: what some pick names, its `ops` globs matching operations and reads alike. */
function pickedBy(picks: ReadonlyArray<ConnectionPick>): StepAllows {
  return (connection, name) =>
    picks.some(
      (pick) =>
        pick.connection === connection &&
        (pick.ops === undefined || matchesAnyGlob(pick.ops, name)),
    );
}

/** What a step with no `tools` may use: every connection but those only some step lists. */
function sharedIn(turn: StepConnections | undefined): StepAllows {
  return (connection) => turn?.runtime.scopeOf(connection, turn.rootId) !== 'step';
}

//#endregion
