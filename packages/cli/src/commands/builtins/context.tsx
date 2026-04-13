/**
 * /context command - Shows current context usage.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { ConversationEntry } from '../../tui/item-utils.js';
import type { Command, LocalJsxCommandCall } from '../types.js';

//#region Types

interface ContextDisplayProps {
  model: string;
  entries: ReadonlyArray<ConversationEntry>;
}

interface StatRowProps {
  label: string;
  value: string | number;
  color?: string;
}

//#endregion

//#region Helpers

function countByType(entries: ReadonlyArray<ConversationEntry>): {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  errors: number;
} {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let errors = 0;

  for (const entry of entries) {
    if ('role' in entry && entry.role === 'user') {
      userMessages++;
      continue;
    }
    if ('type' in entry) {
      if (entry.type === 'error') {
        errors++;
        continue;
      }
      if (entry.type === 'message') {
        assistantMessages++;
        continue;
      }
      if (entry.type === 'function_call' || entry.type === 'function_call_output') {
        toolCalls++;
      }
    }
  }

  return {
    userMessages,
    assistantMessages,
    toolCalls,
    errors,
  };
}

//#endregion

//#region Components

function StatRow({ label, value, color = 'white' }: StatRowProps): ReactNode {
  return (
    <Box>
      <Box width={20}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text color={color}>{String(value)}</Text>
    </Box>
  );
}

function ContextDisplay({ model, entries }: ContextDisplayProps): ReactNode {
  const counts = countByType(entries);
  const totalMessages = counts.userMessages + counts.assistantMessages;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>Context Status</Text>
      <Box height={1} />

      <Box flexDirection="column" marginLeft={2}>
        <StatRow label="Model" value={model} color="cyan" />
        <StatRow label="Total Messages" value={totalMessages} color="green" />
        <StatRow label="  User" value={counts.userMessages} />
        <StatRow label="  Assistant" value={counts.assistantMessages} />
        <StatRow label="Tool Calls" value={counts.toolCalls} color="yellow" />
        {counts.errors > 0 && <StatRow label="Errors" value={counts.errors} color="red" />}
      </Box>

      <Box height={1} />
      <Text dimColor>Note: Token usage tracking coming soon.</Text>
    </Box>
  );
}

//#endregion

//#region Implementation

const call: LocalJsxCommandCall = async (_onDone, ctx, _args) => {
  return <ContextDisplay model={ctx.config.model} entries={ctx.entries} />;
};

//#endregion

//#region Command Definition

export const context: Command = {
  type: 'local-jsx',
  name: 'context',
  description: 'Show current context usage',
  load: async () => ({
    call,
  }),
};

//#endregion
