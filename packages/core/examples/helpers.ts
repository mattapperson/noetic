import type { LLMResponse } from '../src/types/common';
import type { FunctionCallItem, FunctionCallOutputItem, MessageItem } from '../src/types/items';

//#region Types

type MockCallModelScript = LLMResponse[];

interface ToolCallResponseOpts {
  toolName: string;
  args: string;
  output: string;
  finalText: string;
}

//#endregion

//#region Mock Call Model

/** Creates a mock callModel that returns scripted LLM responses in order. */
export function createScriptedCallModel(script: MockCallModelScript): () => Promise<LLMResponse> {
  let callIndex = 0;
  return async (): Promise<LLMResponse> => {
    if (callIndex >= script.length) {
      throw new Error(`Mock callModel exhausted after ${script.length} calls`);
    }
    const response = script[callIndex];
    callIndex++;
    return response;
  };
}

//#endregion

//#region Response Builders

export function assistantMessage(text: string, id?: string): MessageItem {
  return {
    id: id ?? `msg-${crypto.randomUUID()}`,
    status: 'completed',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
  };
}

export function toolCallResponse(opts: ToolCallResponseOpts): LLMResponse {
  const callId = `call_${crypto.randomUUID()}`;
  return {
    items: [
      {
        id: `fc-${callId}`,
        status: 'completed',
        type: 'function_call',
        call_id: callId,
        name: opts.toolName,
        arguments: opts.args,
      } satisfies FunctionCallItem,
      {
        id: `fco-${callId}`,
        status: 'completed',
        type: 'function_call_output',
        call_id: callId,
        output: opts.output,
      } satisfies FunctionCallOutputItem,
      assistantMessage(opts.finalText),
    ],
    usage: {
      inputTokens: 50,
      outputTokens: 30,
    },
    cost: 0.001,
  };
}

export function textOnlyResponse(text: string): LLMResponse {
  return {
    items: [
      assistantMessage(text),
    ],
    usage: {
      inputTokens: 50,
      outputTokens: 30,
    },
    cost: 0.001,
  };
}

//#endregion
