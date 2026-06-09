/**
 * Entry dispatch — maps ConversationEntry / DisplayEntry to its item renderer.
 *
 * Co-locating the dispatch with the item imports keeps consumer files
 * (responses-chat, transcript-view) from importing every item component
 * directly, which keeps their fan-out under the sentrux god-file cap and
 * lets the items barrel stay deleted.
 *
 * Two entry points:
 *  - `renderEntry`         — collapsed/streaming view used by ResponsesChat
 *  - `renderExpandedEntry` — full-output view used by TranscriptView
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { CollapsedReadGroup, DisplayEntry } from '../../grouping/types.js';
import { isCollapsedReadGroup } from '../../grouping/types.js';
import type { ConversationEntry } from '../../item-utils.js';
import {
  extractReasoning,
  extractTextContent,
  getItemId,
  isErrorEntry,
  isSystemEntry,
  isUserEntry,
} from '../../item-utils.js';
import { previewToolArgs } from '../../tool-args-preview.js';
import type { ChatStatus } from '../prompt-input.js';
import { AssistantText } from './assistant-text.js';
import { BashResult } from './bash-result.js';
import { CollapsedReadGroupView } from './collapsed-read-group.js';
import { EditResult } from './edit-result.js';
import { LspResult } from './lsp-result.js';
import { MessageResponse } from './message-response.js';
import { Reasoning } from './reasoning.js';
import { SystemMessage } from './system-message.js';
import type { ToolCallStatus } from './tool-call.js';
import { ToolCall } from './tool-call.js';
import { ToolResult } from './tool-result.js';
import { UserPrompt } from './user-prompt.js';

//#region Types

export interface CallInfo {
  name: string;
  status: ToolCallStatus;
}

/** Visual category of an entry — drives vertical spacing between consecutive
 *  entries. `tool-result` never gets a top margin; other categories get one
 *  when they follow an entry of a different category. */
export type EntryCategory =
  | 'user'
  | 'assistant-text'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'system';

export interface RenderEntryCtx {
  chatStatus: ChatStatus;
  callInfoMap: ReadonlyMap<string, CallInfo>;
  entryCount: number;
  categories: ReadonlyArray<EntryCategory>;
}

export interface RenderExpandedCtx {
  callInfoByCallId: ReadonlyMap<string, CallInfo>;
}

//#endregion

//#region Status + map helpers

export function mapItemStatus(status: string | undefined): ToolCallStatus {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'in_progress' || status === 'searching' || status === 'generating') {
    return 'running';
  }
  if (status === 'incomplete' || status === 'failed') {
    return 'error';
  }
  return 'pending';
}

export function buildCallInfoMap(entries: ReadonlyArray<ConversationEntry>): Map<string, CallInfo> {
  const info = new Map<string, CallInfo>();
  for (const entry of entries) {
    if (isUserEntry(entry) || isErrorEntry(entry) || isSystemEntry(entry)) {
      continue;
    }
    if (entry.type === 'function_call') {
      info.set(entry.callId, {
        name: entry.name,
        status: mapItemStatus(entry.status),
      });
    }
  }
  return info;
}

//#endregion

//#region Category + margin helpers

export function categorize(entry: DisplayEntry): EntryCategory {
  if (isCollapsedReadGroup(entry)) {
    return 'tool-result';
  }
  if (isUserEntry(entry)) {
    return 'user';
  }
  if (isErrorEntry(entry) || isSystemEntry(entry)) {
    return 'system';
  }
  if (entry.type === 'message') {
    return 'assistant-text';
  }
  if (entry.type === 'reasoning') {
    return 'reasoning';
  }
  if (entry.type === 'function_call_output') {
    return 'tool-result';
  }
  return 'tool-call';
}

export function computeCategories(entries: ReadonlyArray<DisplayEntry>): EntryCategory[] {
  return entries.map(categorize);
}

function shouldAddMargin(categories: ReadonlyArray<EntryCategory>, index: number): boolean {
  if (index <= 0) {
    return false;
  }
  const current = categories[index];
  const previous = categories[index - 1];
  if (current === undefined || previous === undefined) {
    return false;
  }
  if (current === 'tool-result') {
    return false;
  }
  return previous !== current;
}

/**
 * True when the previous entry is part of an assistant turn — used to decide
 * whether a system/error message should render as a sub-response (⎿ prefix)
 * under the assistant turn rather than as a standalone top-level line.
 */
function isPartOfAssistantTurn(categories: ReadonlyArray<EntryCategory>, index: number): boolean {
  if (index <= 0) {
    return false;
  }
  const previous = categories[index - 1];
  return (
    previous === 'assistant-text' ||
    previous === 'reasoning' ||
    previous === 'tool-call' ||
    previous === 'tool-result'
  );
}

//#endregion

//#region Collapsed (chat) dispatch

function renderCollapsedGroup(group: CollapsedReadGroup): ReactNode {
  return <CollapsedReadGroupView key={group.id} group={group} />;
}

export function renderEntry(entry: DisplayEntry, index: number, ctx: RenderEntryCtx): ReactNode {
  const addMargin = shouldAddMargin(ctx.categories, index);

  if (isCollapsedReadGroup(entry)) {
    return renderCollapsedGroup(entry);
  }

  if (isUserEntry(entry)) {
    return (
      <UserPrompt
        key={`user-${entry.id ?? index}`}
        text={entry.content}
        addMargin={addMargin}
        deliveryStatus={entry.deliveryStatus}
      />
    );
  }

  if (isErrorEntry(entry)) {
    const asResponse = isPartOfAssistantTurn(ctx.categories, index);
    return (
      <SystemMessage
        key={`error-${index}`}
        text={entry.content}
        type="error"
        asResponse={asResponse}
        addMargin={!asResponse && addMargin}
      />
    );
  }

  if (isSystemEntry(entry)) {
    return (
      <SystemMessage
        key={`system-${index}`}
        text={entry.content}
        type="info"
        addMargin={addMargin}
      />
    );
  }

  const key = getItemId(entry);
  const isLastEntry = index === ctx.entryCount - 1;

  if (entry.type === 'message') {
    const text = extractTextContent(entry);
    if (!text) {
      return null;
    }
    const isStreaming =
      isLastEntry && ctx.chatStatus === 'streaming' && entry.status !== 'completed';
    return <AssistantText key={key} text={text} isStreaming={isStreaming} addMargin={addMargin} />;
  }

  if (entry.type === 'reasoning') {
    return (
      <Reasoning
        key={key}
        text={extractReasoning(entry)}
        collapsed={entry.status === 'completed'}
        addMargin={addMargin}
      />
    );
  }

  if (entry.type === 'function_call') {
    const name = entry.name ?? 'tool';
    return (
      <ToolCall
        key={key}
        name={name}
        status={mapItemStatus(entry.status)}
        args={previewToolArgs(name, entry.arguments ?? '')}
        addMargin={addMargin}
      />
    );
  }

  if (entry.type === 'function_call_output') {
    const info = ctx.callInfoMap.get(entry.callId);
    const isError = info?.status === 'error';
    if (info?.name === 'Edit') {
      return <EditResult key={key} output={entry.output} />;
    }
    if (info?.name === 'Bash') {
      return <BashResult key={key} output={entry.output} />;
    }
    if (info?.name === 'lsp') {
      return (
        <LspResult
          key={key}
          output={entry.output}
          isError={isError}
          fallback={<ToolResult output={entry.output} isError={isError} />}
        />
      );
    }
    return <ToolResult key={key} output={entry.output} isError={isError} />;
  }

  if (
    entry.type === 'web_search_call' ||
    entry.type === 'file_search_call' ||
    entry.type === 'image_generation_call'
  ) {
    return (
      <ToolCall
        key={key}
        name={entry.type.replace('_call', '')}
        status={mapItemStatus(entry.status)}
        addMargin={addMargin}
      />
    );
  }

  return null;
}

//#endregion

//#region Expanded (transcript) dispatch

function asDisplayString(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (output === null || output === undefined) {
    return '';
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function renderResultForTool(toolName: string, output: unknown, isError: boolean): ReactNode {
  if (toolName === 'Edit') {
    return <EditResult output={output} expanded />;
  }
  if (toolName === 'Bash') {
    return <BashResult output={output} expanded />;
  }
  if (toolName === 'lsp') {
    return (
      <LspResult
        output={output}
        isError={isError}
        expanded
        fallback={<ToolResult output={output} isError={isError} />}
      />
    );
  }
  const text = asDisplayString(output);
  if (!text) {
    return null;
  }
  return (
    <MessageResponse>
      <Text dimColor={!isError} wrap="wrap">
        {text}
      </Text>
    </MessageResponse>
  );
}

export function renderExpandedEntry(
  entry: ConversationEntry,
  index: number,
  ctx: RenderExpandedCtx,
): ReactNode {
  if (isUserEntry(entry)) {
    return (
      <UserPrompt
        key={`user-${entry.id ?? index}`}
        text={entry.content}
        deliveryStatus={entry.deliveryStatus}
      />
    );
  }
  if (isErrorEntry(entry)) {
    return <SystemMessage key={`error-${index}`} text={entry.content} type="error" />;
  }
  if (isSystemEntry(entry)) {
    return <SystemMessage key={`system-${index}`} text={entry.content} type="info" />;
  }
  const key = getItemId(entry);
  if (entry.type === 'message') {
    const text = extractTextContent(entry);
    if (!text) {
      return null;
    }
    if (entry.role === 'user') {
      return <UserPrompt key={key} text={text} />;
    }
    if (entry.role === 'system' || entry.role === 'developer') {
      return <SystemMessage key={key} text={text} type="info" />;
    }
    return <AssistantText key={key} text={text} />;
  }
  if (entry.type === 'reasoning') {
    return <Reasoning key={key} text={extractReasoning(entry)} collapsed={false} />;
  }
  if (entry.type === 'function_call') {
    const info = ctx.callInfoByCallId.get(entry.callId);
    return (
      <ToolCall
        key={key}
        name={entry.name ?? 'tool'}
        status={info?.status ?? 'completed'}
        args={entry.arguments}
      />
    );
  }
  if (entry.type === 'function_call_output') {
    const info = ctx.callInfoByCallId.get(entry.callId);
    const isError = info?.status === 'error';
    return (
      <Box key={key} flexDirection="column">
        {renderResultForTool(info?.name ?? '', entry.output, isError) ?? (
          <ToolResult output={entry.output} isError={isError} />
        )}
      </Box>
    );
  }
  return null;
}

//#endregion
