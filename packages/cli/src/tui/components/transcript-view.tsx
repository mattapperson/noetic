/**
 * Full-screen overlay used by both ctrl+o (transcript) and ctrl+r (request items).
 *
 * Replaces the main chat tree with every tool result expanded:
 *   - Edit diffs: no 10-line cap
 *   - Bash output: no cap
 *   - Read/Ls/Find/Grep: raw output text (no grouping, no one-liner)
 *
 * The overlay is purely presentational — the parent owns open/close state
 * and key handling.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { staticKeyFor } from '../grouping/types.js';
import type { ConversationEntry } from '../item-utils.js';
import {
  extractReasoning,
  extractTextContent,
  getItemId,
  isErrorEntry,
  isSystemEntry,
  isUserEntry,
} from '../item-utils.js';
import { AssistantText } from './items/assistant-text.js';
import { BashResult } from './items/bash-result.js';
import { EditResult } from './items/edit-result.js';
import { LspResult } from './items/lsp-result.js';
import { MessageResponse } from './items/message-response.js';
import { Reasoning } from './items/reasoning.js';
import { SystemMessage } from './items/system-message.js';
import type { ToolCallStatus } from './items/tool-call.js';
import { ToolCall } from './items/tool-call.js';
import { ToolResult } from './items/tool-result.js';
import { UserPrompt } from './items/user-prompt.js';
import { useTheme } from './theme.js';

//#region Types

export interface CallInfo {
  name: string;
  status: ToolCallStatus;
}

export interface TranscriptViewProps {
  entries: ReadonlyArray<ConversationEntry>;
  callInfoByCallId: ReadonlyMap<string, CallInfo>;
  /** Header title. Defaults to "Transcript". */
  title?: string;
  /** Subtitle hint after the title. Defaults to the ctrl+o close hint. */
  closeHint?: string;
  /** When true, every entry row renders on a green background. */
  highlightItems?: boolean;
}

interface TranscriptItem {
  readonly key: string;
  readonly entry: ConversationEntry;
  readonly index: number;
}

//#endregion

//#region Helpers

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

//#endregion

//#region Entry Dispatch

interface DispatchCtx {
  callInfoByCallId: ReadonlyMap<string, CallInfo>;
}

function renderExpandedEntry(entry: ConversationEntry, index: number, ctx: DispatchCtx): ReactNode {
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

//#region Component

export function TranscriptView({
  entries,
  callInfoByCallId,
  title = 'Transcript',
  closeHint = ' — press ctrl+o or Esc to close',
  highlightItems = false,
}: TranscriptViewProps): ReactNode {
  const theme = useTheme();
  const items = useMemo<TranscriptItem[]>(
    () =>
      entries.map((entry, index) => ({
        key: staticKeyFor(entry, index),
        entry,
        index,
      })),
    [
      entries,
    ],
  );
  const rowBackground = highlightItems ? 'green' : undefined;
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" marginBottom={1}>
        <Text color={theme.accent} bold>
          {title}
        </Text>
        <Text dimColor>{closeHint}</Text>
      </Box>
      {items.map((item) => (
        <Box key={item.key} flexDirection="column" backgroundColor={rowBackground}>
          {renderExpandedEntry(item.entry, item.index, {
            callInfoByCallId,
          })}
        </Box>
      ))}
    </Box>
  );
}

//#endregion
