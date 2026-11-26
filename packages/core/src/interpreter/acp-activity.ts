/**
 * An agent's `session/update` data in the harness's own activity vocabulary
 * (`@noetic-tools/types` tool-activity): how a tool call presents, what it
 * produced, how far along it is, the agent's plan and its settings. The event
 * bridge (`acp-events`) puts these on the generic events, so a host reads an
 * agent's activity exactly as it reads a `callModel` step's — never the
 * protocol's own fields (spec 27 § Output → harness events).
 */

import type {
  AcpContentBlock,
  AcpSessionConfigOption,
  AcpSessionNotification,
  AcpToolCallContent,
  AgentPlan,
  PlanEntry,
  ToolCallPresentation,
  ToolCallProgress,
  ToolCallStatus,
  ToolContent,
  ToolLocation,
} from '@noetic-tools/types';
import { clampProgress } from '@noetic-tools/types';

//#region Types

type SessionUpdate = AcpSessionNotification['update'];

/** A `tool_call` or `tool_call_update`. */
export type ToolCallUpdate = Extract<
  SessionUpdate,
  {
    sessionUpdate: 'tool_call' | 'tool_call_update';
  }
>;

type PlanUpdate = Extract<
  SessionUpdate,
  {
    sessionUpdate: 'plan' | 'plan_update';
  }
>;

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optional<K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> {
  if (value === undefined || value === null) {
    return {};
  }
  return frameworkRecord(key, value);
}

function frameworkRecord<K extends string, V>(key: K, value: V): Partial<Record<K, V>> {
  const record: Partial<Record<K, V>> = {};
  record[key] = value;
  return record;
}

//#endregion

//#region Content

/** Base64 data as a data URL, so it carries its media type. */
export function dataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

/**
 * One content block, as tool content: text and media as the content parts a
 * model is given (an image as `input_image`, audio as `input_file`, each a
 * data URL), a resource as itself.
 */
export function blockContent(block: AcpContentBlock): ToolContent {
  if (block.type === 'text') {
    return {
      type: 'input_text',
      text: block.text,
    };
  }
  if (block.type === 'image') {
    return {
      type: 'input_image',
      imageUrl: dataUrl(block.mimeType, block.data),
    };
  }
  if (block.type === 'audio') {
    return {
      type: 'input_file',
      fileData: dataUrl(block.mimeType, block.data),
    };
  }
  if (block.type === 'resource_link') {
    return {
      type: 'resource_link',
      uri: block.uri,
      name: block.name,
      ...optional('title', block.title),
      ...optional('mimeType', block.mimeType),
    };
  }
  const resource = block.resource;
  return {
    type: 'resource',
    uri: resource.uri,
    ...optional('mimeType', resource.mimeType),
    ...('text' in resource
      ? {
          text: resource.text,
        }
      : {
          blob: resource.blob,
        }),
  };
}

/** A tool call's content, as tool content: blocks, diffs and terminals. */
export function toolContentOf(
  content: ReadonlyArray<AcpToolCallContent> | null | undefined,
): ToolContent[] {
  return (content ?? []).map((entry): ToolContent => {
    if (entry.type === 'diff') {
      return {
        type: 'diff',
        path: entry.path,
        oldText: entry.oldText ?? null,
        newText: entry.newText,
      };
    }
    if (entry.type === 'terminal') {
      return {
        type: 'terminal',
        terminalId: entry.terminalId,
      };
    }
    return blockContent(entry.content);
  });
}

/** The text a call's content carries, when it carries any. */
export function contentText(content: ReadonlyArray<ToolContent>): string | undefined {
  const texts = content.flatMap((entry) =>
    entry.type === 'input_text'
      ? [
          entry.text,
        ]
      : [],
  );
  return texts.length > 0 ? texts.join('\n') : undefined;
}

//#endregion

//#region Tool calls

/** How a call presents, from what this update says of it: title, kind, locations. */
export function presentationOf(update: ToolCallUpdate): ToolCallPresentation {
  const locations = update.locations?.map(
    (location): ToolLocation => ({
      path: location.path,
      ...optional('line', location.line),
    }),
  );
  return {
    ...optional('title', update.title),
    ...optional('kind', update.kind),
    ...(locations && locations.length > 0
      ? {
          locations,
        }
      : {}),
  };
}

/**
 * How far along a call is, as the agent reports it: `_meta.progress` or its
 * raw output's `progress`, 0…1 or a percentage.
 */
export function progressOf(update: ToolCallUpdate): number | undefined {
  const meta = update._meta;
  const raw = isRecord(update.rawOutput) ? update.rawOutput : undefined;
  return clampProgress(meta?.progress) ?? clampProgress(raw?.progress);
}

/** What a non-final update reports of a running call; undefined when it reports nothing. */
export function progressReport(
  update: ToolCallUpdate,
  status: ToolCallStatus | undefined,
): ToolCallProgress | undefined {
  const progress = progressOf(update);
  const report: ToolCallProgress = {
    ...presentationOf(update),
    ...optional('status', status),
    ...optional('progress', progress),
    ...(update.content
      ? {
          content: toolContentOf(update.content),
        }
      : {}),
  };
  return Object.keys(report).length > 0 ? report : undefined;
}

//#endregion

//#region Plans and settings

function planEntries(entries: ReadonlyArray<PlanEntry>): PlanEntry[] {
  return entries.map((entry) => ({
    content: entry.content,
    priority: entry.priority,
    status: entry.status,
  }));
}

/** The plan a `plan` or draft `plan_update` carries, whole. */
export function planOf(update: PlanUpdate): AgentPlan {
  if (update.sessionUpdate === 'plan') {
    return {
      entries: planEntries(update.entries),
    };
  }
  const plan = update.plan;
  if (plan.type === 'items') {
    return {
      id: plan.planId,
      entries: planEntries(plan.entries),
    };
  }
  if (plan.type === 'markdown') {
    return {
      id: plan.planId,
      markdown: plan.content,
    };
  }
  return {
    id: plan.planId,
    uri: plan.uri,
  };
}

/**
 * The session's model: its `model` config option's current value, found by
 * category, else by id — as the step finds it to set it.
 */
export function modelOf(
  options: ReadonlyArray<AcpSessionConfigOption> | null | undefined,
): string | undefined {
  const selects = (options ?? []).filter((option) => option.type === 'select');
  const option =
    selects.find((candidate) => candidate.category === 'model') ??
    selects.find((candidate) => candidate.id === 'model');
  return option?.type === 'select' ? option.currentValue : undefined;
}

/**
 * How hard the session's model thinks: its reasoning option's current value,
 * found by the protocol's `thought_level` category, else by the ids Claude
 * Code (`effort`) and Codex (`reasoning_effort`) give it.
 */
export function effortOf(
  options: ReadonlyArray<AcpSessionConfigOption> | null | undefined,
): string | undefined {
  const selects = (options ?? []).filter((option) => option.type === 'select');
  const option =
    selects.find((candidate) => candidate.category === 'thought_level') ??
    selects.find((candidate) => candidate.id === 'effort' || candidate.id === 'reasoning_effort');
  return option?.type === 'select' ? option.currentValue : undefined;
}

//#endregion
