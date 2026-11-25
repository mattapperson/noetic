/**
 * Resolve a tool's presentation declaration (`Tool.presentation`, else its
 * deprecated `acp`) into the fields a call's events carry. Shared by every
 * path that reports a tool call — the `callModel` tool loop, an agent step's
 * tool bridge, a served harness — so a call presents the same way on each.
 *
 * A declaration method that throws presents nothing for that point: it is
 * presentation, and must never fail a call.
 */

import type { Tool, ToolPresentationDeclaration } from '../types/tool';
import type {
  ToolCallPresentation,
  ToolCallProgress,
  ToolContent,
  ToolLocation,
} from '../types/tool-activity';
import { frameworkCast } from './framework-cast';

//#region Helpers

type Declaration = Pick<ToolPresentationDeclaration, 'kind' | 'title'> & {
  locations?(args: unknown): Array<string | ToolLocation>;
  progress?(events: unknown[]): ToolCallProgress | null;
  content?(output: unknown, args: unknown): ToolContent[];
};

/** The tool's declaration, its methods typed for the runtime values they get. */
function declarationOf(
  tool: Pick<Tool, 'presentation' | 'acp'> | undefined,
): Declaration | undefined {
  const declared = tool?.presentation ?? tool?.acp;
  return declared === undefined ? undefined : frameworkCast<Declaration>(declared);
}

function attempt<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

function toLocation(entry: string | ToolLocation): ToolLocation {
  return typeof entry === 'string'
    ? {
        path: entry,
      }
    : entry;
}

//#endregion

//#region Public API

/**
 * How a call to `tool` with `args` presents: its declared title, kind and
 * locations. `args` undefined (not parsed yet) gives a string title and the
 * kind only. Fields the tool does not declare are absent.
 * @public
 */
export function presentToolCall(
  tool: Pick<Tool, 'presentation' | 'acp'> | undefined,
  args: unknown,
): ToolCallPresentation {
  const declared = declarationOf(tool);
  if (!declared) {
    return {};
  }
  const presentation: ToolCallPresentation = {};
  if (declared.kind !== undefined) {
    presentation.kind = declared.kind;
  }
  const title = declared.title;
  if (typeof title === 'string') {
    presentation.title = title;
  }
  if (typeof title === 'function' && args !== undefined) {
    const titled = attempt(() => title(frameworkCast<never>(args)));
    if (typeof titled === 'string' && titled.length > 0) {
      presentation.title = titled;
    }
  }
  const locate = declared.locations;
  if (locate && args !== undefined) {
    const locations = attempt(() => locate(args));
    if (Array.isArray(locations) && locations.length > 0) {
      presentation.locations = locations.map(toLocation);
    }
  }
  return presentation;
}

/**
 * What a running call reports after `events` (every event its generator has
 * yielded so far), or undefined when the tool declares no progress or reports
 * nothing for these. `progress` is clamped to 0…1.
 * @public
 */
export function presentToolProgress(
  tool: Pick<Tool, 'presentation' | 'acp'> | undefined,
  events: unknown[],
): ToolCallProgress | undefined {
  const report = declarationOf(tool)?.progress;
  if (!report) {
    return undefined;
  }
  // A copy, read inside the guard: what the tool returned is never written
  // to, and nothing in it can fail the call.
  return attempt(() => normalizedProgress(report(events)));
}

function normalizedProgress(progress: ToolCallProgress | null): ToolCallProgress | undefined {
  if (!progress) {
    return undefined;
  }
  const { locations, progress: fraction, ...rest } = progress;
  const clamped = clampProgress(fraction);
  return {
    ...rest,
    ...(locations
      ? {
          locations: locations.map(toLocation),
        }
      : {}),
    ...(clamped === undefined
      ? {}
      : {
          progress: clamped,
        }),
  };
}

/**
 * What a call that did not fail produced, as structure, or undefined when the
 * tool declares no content or gives none.
 * @public
 */
export function presentToolContent(
  tool: Pick<Tool, 'presentation' | 'acp'> | undefined,
  output: unknown,
  args: unknown,
): ToolContent[] | undefined {
  const produce = declarationOf(tool)?.content;
  if (!produce) {
    return undefined;
  }
  const content = attempt(() => produce(output, args));
  return Array.isArray(content) && content.length > 0 ? content : undefined;
}

/**
 * A progress figure as a fraction from 0 to 1: a value above 1 is read as a
 * percentage. Undefined for anything that is not a finite number.
 * @public
 */
export function clampProgress(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const fraction = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0, fraction));
}

//#endregion
