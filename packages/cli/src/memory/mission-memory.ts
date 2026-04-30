import { randomUUID } from 'node:crypto';
import type { ExecutionContext, InputMessageItem, MemoryLayer, MemoryScope } from '@noetic/core';
import { layerData, layerFn, Slot } from '@noetic/core';
import { z } from 'zod';
import type {
  MissionContractAssertionRecord,
  MissionFeatureRecord,
  MissionRecord,
  SliceRecord,
} from '../commands/builtins/tasks/db/schema.js';
import type {
  MissionHierarchyAssertion,
  MissionHierarchyFeature,
  MissionHierarchyMilestone,
  MissionHierarchySlice,
} from '../commands/builtins/tasks/missions/store.js';
import {
  computeMissionStatus,
  getMissionWithHierarchy,
  markFeaturePassed,
} from '../commands/builtins/tasks/missions/store.js';

//#region Internal helpers (mirrors @noetic/core/interpreter/message-helpers, which is internal)

function createMessage(text: string, role: 'developer' | 'user'): InputMessageItem {
  return {
    id: randomUUID(),
    status: 'completed',
    type: 'message',
    role,
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

//#endregion

//#region Constants

/** Slot just below `planMemory` (240) so plan recall comes first when both active. */
const MISSION_SLOT = Slot.PROCEDURAL - 5;

const MAX_DESCRIPTION_LENGTH = 4e3;

//#endregion

//#region Types

/** @public State shape for the mission memory layer — one pointer pair per thread. */
export interface MissionState {
  cwd: string;
  activeMissionId: string | null;
  activeFeatureId: string | null;
}

/** @public Snapshot returned by the `mission/current` data provider. */
export interface MissionCurrentSnapshot {
  mission: MissionRecord;
  slice: SliceRecord;
  feature: MissionFeatureRecord;
  assertions: ReadonlyArray<MissionContractAssertionRecord>;
}

/** @public Configuration for {@link missionMemory}. */
export interface MissionMemoryConfig {
  /** Working directory used to open the tasks SQLite database. */
  cwd: string;
  /** Override the layer scope. Defaults to `'thread'`. */
  scope?: MemoryScope;
  /** Optional initial pointer pair — primarily for tests. */
  initial?: {
    activeMissionId?: string | null;
    activeFeatureId?: string | null;
  };
}

//#endregion

//#region Helpers

interface ResolvedFeatureContext {
  mission: MissionRecord;
  milestone: MissionHierarchyMilestone;
  slice: MissionHierarchySlice;
  feature: MissionHierarchyFeature;
  assertions: ReadonlyArray<MissionHierarchyAssertion>;
}

function resolveFeatureContext(
  cwd: string,
  missionId: string,
  featureId: string,
): ResolvedFeatureContext | null {
  const hierarchy = getMissionWithHierarchy(cwd, missionId);
  if (hierarchy === null) {
    return null;
  }
  for (const milestone of hierarchy.milestones) {
    for (const slice of milestone.slices) {
      const feature = slice.features.find((row) => row.id === featureId);
      if (!feature) {
        continue;
      }
      const assertions = milestone.assertions.filter((assertion) =>
        assertion.featureIdsParsed.includes(featureId),
      );
      return {
        mission: hierarchy.mission,
        milestone,
        slice,
        feature,
        assertions,
      };
    }
  }
  return null;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function truncate(value: string | null | undefined, maxLength: number): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…`;
}

function renderMissionContext(resolved: ResolvedFeatureContext): string {
  const { mission, slice, feature, assertions } = resolved;
  const lines: string[] = [];
  lines.push('<mission_context>');
  lines.push(
    `  <mission id="${escapeXml(mission.id)}" title="${escapeXml(mission.title)}" description="${escapeXml(truncate(mission.description, MAX_DESCRIPTION_LENGTH))}"/>`,
  );
  lines.push(
    `  <slice id="${escapeXml(slice.id)}" title="${escapeXml(slice.title)}" verification="${escapeXml(truncate(slice.verification, MAX_DESCRIPTION_LENGTH))}"/>`,
  );
  lines.push(
    `  <feature id="${escapeXml(feature.id)}" title="${escapeXml(feature.title)}" description="${escapeXml(truncate(feature.description, MAX_DESCRIPTION_LENGTH))}">`,
  );
  lines.push('    <acceptance_criteria>');
  for (const criterion of feature.acceptanceCriteriaParsed) {
    lines.push(`      <criterion>${escapeXml(criterion)}</criterion>`);
  }
  lines.push('    </acceptance_criteria>');
  lines.push('    <assertions>');
  for (const assertion of assertions) {
    lines.push(
      `      <assertion id="${escapeXml(assertion.id)}" status="${escapeXml(assertion.status)}">${escapeXml(assertion.assertion)}</assertion>`,
    );
  }
  lines.push('    </assertions>');
  lines.push('  </feature>');
  lines.push('</mission_context>');
  return lines.join('\n');
}

function buildCurrentSnapshot(state: MissionState): MissionCurrentSnapshot | null {
  if (state.activeMissionId === null || state.activeFeatureId === null) {
    return null;
  }
  const resolved = resolveFeatureContext(state.cwd, state.activeMissionId, state.activeFeatureId);
  if (resolved === null) {
    return null;
  }
  return {
    mission: resolved.mission,
    slice: resolved.slice,
    feature: resolved.feature,
    assertions: resolved.assertions,
  };
}

//#endregion

//#region Provides — Zod schemas

const FeatureIdInputSchema = z.object({
  featureId: z.string().min(1),
});

const MarkFeatureCompleteInputSchema = z.object({
  featureId: z.string().min(1),
  summary: z.string().optional(),
});

const FeatureSchema = z.unknown();
const AssertionListSchema = z.unknown();
const MarkFeatureCompleteOutputSchema = z.object({
  ok: z.literal(true),
  newMissionStatus: z.string(),
});

//#endregion

//#region Public API

/**
 * @public
 * Mission-aware memory layer that exposes the active mission/slice/feature plus
 * its assertions to the LLM as a developer-role recall block, and provides
 * tools for the agent to read or complete feature work.
 *
 * The layer no-ops while `activeFeatureId` is `null`; mounting it
 * unconditionally is safe.
 */
export function missionMemory(config: MissionMemoryConfig): MemoryLayer<MissionState> {
  const scope: MemoryScope = config.scope ?? 'thread';
  const initialState: MissionState = {
    cwd: config.cwd,
    activeMissionId: config.initial?.activeMissionId ?? null,
    activeFeatureId: config.initial?.activeFeatureId ?? null,
  };

  return {
    id: 'mission-memory',
    name: 'Mission Memory',
    slot: MISSION_SLOT,
    scope,
    budget: {
      min: 100,
      max: 2e3,
    },
    provides: {
      current: layerData<MissionCurrentSnapshot | null, MissionState>({
        read: (state) => buildCurrentSnapshot(state),
      }),

      getFeature: layerFn<
        {
          featureId: string;
        },
        unknown,
        MissionState
      >({
        description:
          'Fetch a single mission feature row by id. Returns the feature record (id, title, description, acceptanceCriteria, status, loopState, taskId) or `null` when no such feature exists in the active mission.',
        input: FeatureIdInputSchema,
        output: FeatureSchema,
        execute: async (args, state) => {
          if (state.activeMissionId === null) {
            return {
              result: null,
            };
          }
          const resolved = resolveFeatureContext(state.cwd, state.activeMissionId, args.featureId);
          if (resolved === null) {
            return {
              result: null,
            };
          }
          return {
            result: {
              ...resolved.feature,
              acceptanceCriteria: resolved.feature.acceptanceCriteriaParsed,
            },
          };
        },
      }),

      markFeatureComplete: layerFn<
        {
          featureId: string;
          summary?: string;
        },
        {
          ok: true;
          newMissionStatus: string;
        },
        MissionState
      >({
        description:
          'Mark a mission feature as passed (validator pass). Triggers a recompute of the parent mission status. Returns the updated mission status.',
        input: MarkFeatureCompleteInputSchema,
        output: MarkFeatureCompleteOutputSchema,
        execute: async (args, state) => {
          if (state.activeMissionId === null) {
            throw new Error(
              'mission/markFeatureComplete called with no active mission in this thread.',
            );
          }
          markFeaturePassed(state.cwd, args.featureId);
          const newMissionStatus = computeMissionStatus(state.cwd, state.activeMissionId);
          return {
            result: {
              ok: true,
              newMissionStatus,
            },
          };
        },
      }),

      queryAssertions: layerFn<
        {
          featureId: string;
        },
        unknown,
        MissionState
      >({
        description:
          "List the contract assertions associated with a feature, including each assertion's current status (pending|passed|failed|blocked).",
        input: FeatureIdInputSchema,
        output: AssertionListSchema,
        execute: async (args, state) => {
          if (state.activeMissionId === null) {
            return {
              result: [],
            };
          }
          const resolved = resolveFeatureContext(state.cwd, state.activeMissionId, args.featureId);
          if (resolved === null) {
            return {
              result: [],
            };
          }
          return {
            result: resolved.assertions.map((assertion) => ({
              id: assertion.id,
              statement: assertion.assertion,
              status: assertion.status,
            })),
          };
        },
      }),
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<MissionState>('state');
        return {
          state: saved ?? initialState,
        };
      },

      async recall({ state }) {
        if (state.activeMissionId === null || state.activeFeatureId === null) {
          return null;
        }
        const resolved = resolveFeatureContext(
          state.cwd,
          state.activeMissionId,
          state.activeFeatureId,
        );
        if (resolved === null) {
          return null;
        }
        const content = renderMissionContext(resolved);
        return {
          items: [
            createMessage(content, 'developer'),
          ],
          tokenCount: estimateTokens(content),
        };
      },

      async onSpawn({ parentState }) {
        return {
          childState: structuredClone(parentState),
        };
      },
    },
  } satisfies MemoryLayer<MissionState>;
}

//#endregion

//#region Internal context type re-export

/** Exported solely for tests that need to construct an ExecutionContext literal. */
export type MissionMemoryExecutionContext = ExecutionContext;

//#endregion
