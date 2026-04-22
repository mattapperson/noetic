/**
 * Full-screen transcript overlay — rendered when the user presses ctrl+o.
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
import type { ConversationEntry } from '../item-utils.js';
import {
  extractReasoning,
  extractTextContent,
  getItemId,
  isErrorEntry,
  isSystemEntry,
  isUserEntry,
} from '../item-utils.js';
import type { ToolCallStatus } from './items/index.js';
import {
  AssistantText,
  BashResult,
  EditResult,
  MessageResponse,
  Reasoning,
  SystemMessage,
  ToolCall,
  ToolResult,
  UserPrompt,
} from './items/index.js';
import { useTheme } from './theme.js';

//#region Types

export interface CallInfo {
  name: string;
  status: ToolCallStatus;
}

export interface TranscriptViewProps {
  entries: ReadonlyArray<ConversationEntry>;
  callInfoByCallId: ReadonlyMap<string, CallInfo>;
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
  const text = asDisplayString(output);
  if (!text) {
    return null;
  }
  return (
    <MessageResponse>
      <Text dimColor={!isError}>{text}</Text>
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

export function TranscriptView({ entries, callInfoByCallId }: TranscriptViewProps): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" marginBottom={1}>
        <Text color={theme.accent} bold>
          Transcript
        </Text>
        <Text dimColor> — press ctrl+o or Esc to close</Text>
      </Box>
      {entries.map((entry, index) => (
        <Box key={getKey(entry, index)} flexDirection="column">
          {renderExpandedEntry(entry, index, {
            callInfoByCallId,
          })}
        </Box>
      ))}
    </Box>
  );
}

function getKey(entry: ConversationEntry, index: number): string {
  if (isUserEntry(entry)) {
    return `user-${entry.id ?? index}`;
  }
  if (isErrorEntry(entry)) {
    return `error-${index}`;
  }
  if (isSystemEntry(entry)) {
    return `system-${index}`;
  }
  return getItemId(entry);
}

//#endregion
