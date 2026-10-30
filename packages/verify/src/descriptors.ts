/**
 * Sense descriptors: OVP channel descriptors for each sense a participant
 * declares. A server may declare a named sense less trustworthy than OVP's
 * default, never more (OVP-CHAN-1), so declarations are clamped to the default.
 */

import type { SenseDescriptor } from '@noetic-tools/types';
import { SenseDefaults } from '@noetic-tools/types';
import type { ChannelDescriptor } from '@noetic-tools/types/verify';

//#region Constants

const GRADE_RANK: Readonly<Record<SenseDescriptor['grade'], number>> = {
  context: 0,
  presence: 1,
  consequence: 2,
};

//#endregion

//#region Helpers

function defaultOf(sense: string): SenseDescriptor | undefined {
  if (!(sense in SenseDefaults)) {
    return undefined;
  }
  return Object.entries(SenseDefaults).find(([name]) => name === sense)?.[1];
}

//#endregion

//#region Public API

/** A declared sense as an OVP channel descriptor, clamped to OVP's default for a named sense. */
export function channelDescriptor(
  sense: string,
  declared: SenseDescriptor | undefined,
): ChannelDescriptor | undefined {
  const fallback = defaultOf(sense);
  const own = declared ?? fallback;
  if (!own) {
    return undefined;
  }
  if (!fallback) {
    return {
      id: sense,
      independence: own.independence,
      grade: own.grade,
      ...(own.note === undefined
        ? {}
        : {
            note: own.note,
          }),
    };
  }
  const independence =
    fallback.independence === 'actuation-derived' ? 'actuation-derived' : own.independence;
  const grade = GRADE_RANK[own.grade] <= GRADE_RANK[fallback.grade] ? own.grade : fallback.grade;
  return {
    id: sense,
    independence,
    grade,
    ...(own.note === undefined
      ? {}
      : {
          note: own.note,
        }),
  };
}

/** Every sense a manifest declares, as OVP channel descriptors. */
export function channelDescriptors(
  senses: Readonly<Record<string, SenseDescriptor>>,
): ChannelDescriptor[] {
  return Object.entries(senses)
    .map(([sense, declared]) => channelDescriptor(sense, declared))
    .filter((d): d is ChannelDescriptor => d !== undefined);
}

//#endregion
