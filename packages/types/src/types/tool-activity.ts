/**
 * The vocabulary a host reads an agent's activity in: how a tool call
 * presents, what it produced, and the agent's plan. One vocabulary for every
 * agent — a `callModel` step's tool calls, an agent step's, a nested agent's —
 * so a host shows them all the same way, and nothing in it names a protocol
 * (spec 08 § Tool calls, plans and agent settings).
 */

import type { InputContentPart } from './items';

//#region Tool calls

/**
 * What kind of work a tool call does, so a UI can show it by kind.
 * @public
 */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/**
 * Which tool a call is to, the same for every call to it: a tool's own
 * `name`, or the name an agent gives one of its own tools, with the MCP
 * server it is on when it is an MCP tool. Never a human title (that is
 * `ToolCallPresentation.title`), except for an agent that names its tools no
 * other way.
 * @public
 */
export interface ToolIdentity {
  /** The tool's own name: `read_file`, `Bash`, an MCP tool's name on its server. */
  id: string;
  /** The MCP server the tool is on, when it is an MCP tool. */
  server?: string;
}

/**
 * Where a tool call is in its life. `pending`: announced, not running yet
 * (waiting for approval or for its input to finish streaming).
 * @public
 */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * A file a tool call works on, and the line in it when the call names one.
 * @public
 */
export interface ToolLocation {
  path: string;
  line?: number;
}

/**
 * Something a tool call produced, kept as structure rather than rendered to
 * text. Text and media are the content parts a model is given
 * (`InputContentPart`: `input_text`, `input_image` — its `imageUrl` a URL or a
 * data URL — `input_file`, and any media part added there), so a call's image
 * is the same part a tool's `toModelOutput` returns. The rest is what only a
 * tool call produces: a resource, a file diff, a terminal.
 * @public
 */
export type ToolContent =
  | InputContentPart
  | {
      /** A resource the call points at, not its contents. */
      type: 'resource_link';
      uri: string;
      name: string;
      title?: string;
      mimeType?: string;
    }
  | {
      /** A resource's contents: `text`, or base64 `blob`. */
      type: 'resource';
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    }
  | {
      /** A file the call changed: `oldText` null when it created the file. */
      type: 'diff';
      path: string;
      oldText: string | null;
      newText: string;
    }
  | {
      /** A terminal the call runs in. */
      type: 'terminal';
      terminalId: string;
    };

/**
 * How a tool call presents: a human title, its kind, the files it touches.
 * @public
 */
export interface ToolCallPresentation {
  title?: string;
  kind?: ToolKind;
  locations?: ToolLocation[];
}

/**
 * What a running tool call reports: its presentation as it changes, its
 * status, how far along it is (`progress`, 0…1) and what it has produced so
 * far. Every field is optional: a report carries what changed.
 * @public
 */
export interface ToolCallProgress extends ToolCallPresentation {
  status?: ToolCallStatus;
  /** How far along the call is, from 0 to 1. */
  progress?: number;
  /** What the call has produced so far: replaces what an earlier report gave. */
  content?: ToolContent[];
}

//#endregion

//#region Plans

/** @public How much a plan entry matters. */
export type PlanEntryPriority = 'high' | 'medium' | 'low';

/** @public Where a plan entry is. */
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

/** @public One task of an agent's plan. */
export interface PlanEntry {
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
}

/**
 * An agent's plan, whole: its entries, or a plan written as markdown or kept
 * in a file. Each `plan_updated` replaces the agent's plan with the same `id`
 * (no id: its only plan).
 * @public
 */
export type AgentPlan =
  | {
      id?: string;
      entries: PlanEntry[];
    }
  | {
      id?: string;
      markdown: string;
    }
  | {
      id?: string;
      uri: string;
    };

//#endregion
