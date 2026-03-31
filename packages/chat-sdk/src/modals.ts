import type { ExecuteInput, Item } from '@noetic/core';

import type { ModalInputOptions } from './types';
import { ModalInputMode } from './types';

//#region Types

/** Minimal shape of a modal submit event needed for conversion. */
export interface ModalSubmitValues {
  values: Record<string, string>;
  callbackId: string;
}

//#endregion

//#region Helper

function valuesToUserMessage(values: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    parts.push(`${key}: ${value}`);
  }
  return parts.join('\n');
}

function valuesToItems(values: Record<string, string>): Item[] {
  return [
    {
      id: crypto.randomUUID(),
      status: 'completed',
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: valuesToUserMessage(values),
        },
      ],
    },
  ];
}

//#endregion

//#region Public API

/**
 * Convert a chat-sdk modal form submission to Noetic execution input.
 *
 * Three modes:
 * 1. **message** (default): Serializes values as a readable user message string
 * 2. **structured**: Returns Item[] with the values as a user message
 * 3. **custom mapper**: Uses the provided mapper function to convert values
 *
 * @param event - The modal submit event from chat-sdk
 * @param opts - Conversion options (mode or custom mapper)
 * @returns ExecuteInput suitable for harness.execute()
 *
 * @public
 */
export function modalToNoeticInput(
  event: ModalSubmitValues,
  opts?: ModalInputOptions,
): ExecuteInput {
  if (opts?.mapper) {
    return opts.mapper(event.values, event);
  }

  const mode = opts?.mode ?? ModalInputMode.Message;

  if (mode === ModalInputMode.Structured) {
    return valuesToItems(event.values);
  }

  return valuesToUserMessage(event.values);
}

//#endregion
