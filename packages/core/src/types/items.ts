export interface ItemBase {
  readonly id: string;
  readonly status: 'in_progress' | 'completed' | 'incomplete' | 'failed';
}

export type ContentPart =
  | { type: 'output_text'; text: string }
  | { type: 'input_text'; text: string }
  | { type: 'refusal'; refusal: string };

export interface MessageItem extends ItemBase {
  readonly type: 'message';
  readonly role: 'user' | 'assistant' | 'system' | 'developer';
  readonly content: ContentPart[];
}

export interface FunctionCallItem extends ItemBase {
  readonly type: 'function_call';
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface FunctionCallOutputItem extends ItemBase {
  readonly type: 'function_call_output';
  readonly call_id: string;
  readonly output: string;
}

export interface ReasoningItem extends ItemBase {
  readonly type: 'reasoning';
  readonly content: ContentPart[];
  readonly summary?: ContentPart[];
  readonly encrypted_content?: string;
}

export interface ExtensionItem extends ItemBase {
  readonly type: `x-${string}`;
  readonly data: Record<string, unknown>;
}

export type Item =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem
  | ExtensionItem;
