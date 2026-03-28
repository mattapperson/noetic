/** @public Base fields shared by all conversation item variants. */
export interface ItemBase {
  readonly id: string;
  readonly status: 'in_progress' | 'completed' | 'incomplete' | 'failed';
}

/** @public A single content segment within a message (text, input text, or refusal). */
export type ContentPart =
  | {
      type: 'output_text';
      text: string;
    }
  | {
      type: 'input_text';
      text: string;
    }
  | {
      type: 'refusal';
      refusal: string;
    };

/** @public A conversation message from a user, assistant, system, or developer role. */
export interface MessageItem extends ItemBase {
  readonly type: 'message';
  readonly role: 'user' | 'assistant' | 'system' | 'developer';
  readonly content: ContentPart[];
}

/** @public A tool/function invocation requested by the model. */
export interface FunctionCallItem extends ItemBase {
  readonly type: 'function_call';
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

/** @public The serialized output returned by a tool after execution. */
export interface FunctionCallOutputItem extends ItemBase {
  readonly type: 'function_call_output';
  readonly call_id: string;
  readonly output: string;
}

/** @public Internal reasoning trace emitted by a model (chain-of-thought). */
export interface ReasoningItem extends ItemBase {
  readonly type: 'reasoning';
  readonly content: ContentPart[];
  readonly summary?: ContentPart[];
  readonly encrypted_content?: string;
}

/** @public User-defined extension item with a namespaced `x-` type prefix. */
export interface ExtensionItem extends ItemBase {
  readonly type: `x-${string}`;
  readonly data: Record<string, unknown>;
}

/** @public Union of all conversation item types that can appear in an ItemLog. */
export type Item =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem
  | ExtensionItem;

/** @public Accepted input types for `AgentHarness.execute()`: a plain string, a single Item, or an array of Items. */
export type ExecuteInput = string | Item | Item[];
