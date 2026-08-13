/**
 * Builders that turn ACP session output into Noetic conversation `Item`s. The
 * shapes mirror the OpenRouter output-item schema the runtime stores;
 * construction goes through `frameworkCast` because those provider types are
 * not publicly constructible.
 */

import type {
  AcpContentBlock,
  FunctionCallItem,
  FunctionCallOutputItem,
  Item,
  MessageItem,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';

/** @public Build an assistant message Item from plain text. */
export function assistantMessageItem(text: string, id?: string): MessageItem {
  return frameworkCast<MessageItem>({
    id: id ?? `acp-msg-${crypto.randomUUID()}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  });
}

/**
 * Build a function-call Item recording a tool the agent invoked.
 *
 * ACP identifies a tool call by a human-readable `title` plus a `kind`
 * classification — there is no machine tool name on the wire — so `title`
 * becomes the item's `name` and `kind` rides along in the arguments payload.
 */
export function functionCallItem(opts: {
  title: string;
  toolCallId: string;
  rawInput?: Record<string, unknown>;
  kind?: string;
}): FunctionCallItem {
  const args = JSON.stringify(opts.rawInput ?? {});
  return frameworkCast<FunctionCallItem>({
    id: opts.toolCallId,
    type: 'function_call',
    status: 'completed',
    name: opts.title,
    callId: opts.toolCallId,
    arguments: args,
    acpToolKind: opts.kind,
  });
}

/** @public Build the tool-result Item paired with a completed ACP tool call. */
export function functionCallOutputItem(opts: {
  toolCallId: string;
  output: string;
  failed?: boolean;
}): FunctionCallOutputItem {
  return frameworkCast<FunctionCallOutputItem>({
    id: `acp-tool-output-${opts.toolCallId}`,
    type: 'function_call_output',
    status: opts.failed === true ? 'failed' : 'completed',
    callId: opts.toolCallId,
    output: opts.output,
  });
}

/**
 * Flatten an ACP content block to plain text. Non-text blocks are rendered as a
 * short descriptor rather than dropped, so nothing the agent sent disappears
 * from the transcript.
 */
export function contentBlockText(block: AcpContentBlock): string {
  if (block.type === 'text') {
    return block.text;
  }
  if (block.type === 'resource_link') {
    return `[resource: ${block.uri}]`;
  }
  if (block.type === 'resource') {
    const resource = block.resource;
    return 'text' in resource ? resource.text : `[resource: ${resource.uri}]`;
  }
  return `[${block.type}: ${block.mimeType}]`;
}

/** @public Coerce an arbitrary item collection to the `Item[]` type. */
export function asItems(items: ReadonlyArray<unknown>): Item[] {
  return frameworkCast<Item[]>([
    ...items,
  ]);
}
