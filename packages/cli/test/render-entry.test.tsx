/**
 * Regression coverage for the entry-dispatch extraction
 * (`src/tui/components/items/render-entry.tsx`).
 *
 * Two surfaces:
 *  - Pure helpers (mapItemStatus, buildCallInfoMap, categorize,
 *    computeCategories) — straight unit tests.
 *  - Dispatch entry points (renderEntry, renderExpandedEntry) — assert the
 *    *type* of the returned ReactElement so a wrong-component bug from a
 *    later refactor would fail loudly, without needing ink-testing-library.
 */
import { describe, expect, test } from 'bun:test';
import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { AssistantText } from '../src/tui/components/items/assistant-text.js';
import { BashResult } from '../src/tui/components/items/bash-result.js';
import { CollapsedReadGroupView } from '../src/tui/components/items/collapsed-read-group.js';
import { EditResult } from '../src/tui/components/items/edit-result.js';
import { LspResult } from '../src/tui/components/items/lsp-result.js';
import { Reasoning } from '../src/tui/components/items/reasoning.js';
import type { CallInfo, RenderEntryCtx } from '../src/tui/components/items/render-entry.js';
import {
  buildCallInfoMap,
  categorize,
  computeCategories,
  mapItemStatus,
  renderEntry,
  renderExpandedEntry,
} from '../src/tui/components/items/render-entry.js';
import { SystemMessage } from '../src/tui/components/items/system-message.js';
import { ToolCall } from '../src/tui/components/items/tool-call.js';
import { ToolResult } from '../src/tui/components/items/tool-result.js';
import { UserPrompt } from '../src/tui/components/items/user-prompt.js';
import type { CollapsedReadGroup, DisplayEntry } from '../src/tui/grouping/types.js';
import type { ConversationEntry } from '../src/tui/item-utils.js';

//#region Fixture builders

type FunctionCallStatus = 'in_progress' | 'completed' | 'incomplete';

function userEntry(content: string, id = 'u1'): ConversationEntry {
  return {
    role: 'user',
    content,
    id,
  };
}

function errorEntry(content: string): ConversationEntry {
  return {
    role: 'system',
    type: 'error',
    content,
  };
}

function systemEntry(content: string): ConversationEntry {
  return {
    role: 'system',
    type: 'info',
    content,
  };
}

function assistantMessage(text: string): ConversationEntry {
  return {
    id: `msg-${text}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
  };
}

function userMessage(text: string): ConversationEntry {
  return {
    id: `msg-user-${text}`,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

function systemMessage(text: string): ConversationEntry {
  return {
    id: `msg-system-${text}`,
    type: 'message',
    role: 'system',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

function emptyMessage(): ConversationEntry {
  return {
    id: 'empty',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [],
  };
}

function reasoning(text: string): ConversationEntry {
  return {
    id: `reason-${text}`,
    type: 'reasoning',
    status: 'completed',
    summary: [],
    content: [
      {
        type: 'reasoning_text',
        text,
      },
    ],
  };
}

function callEntry(
  name: string,
  status: FunctionCallStatus = 'completed',
  callId = `cid-${name}`,
): ConversationEntry {
  return {
    id: `call-${name}`,
    type: 'function_call',
    callId,
    name,
    arguments: '{}',
    status,
  };
}

function callOutput(callId: string, output: string): ConversationEntry {
  return {
    id: `out-${callId}`,
    type: 'function_call_output',
    status: 'completed',
    callId,
    output,
  };
}

function collapsedGroup(): CollapsedReadGroup {
  return {
    kind: 'collapsed-read-group',
    id: 'cg-1',
    readPaths: [
      '/a.ts',
      '/b.ts',
    ],
    listPaths: [],
    searchPatterns: [],
    latestHint: '/b.ts',
  };
}

function makeCtx(overrides: Partial<RenderEntryCtx> = {}): RenderEntryCtx {
  return {
    chatStatus: 'streaming',
    callInfoMap: new Map<string, CallInfo>(),
    entryCount: 1,
    categories: [
      'assistant-text',
    ],
    ...overrides,
  };
}

function asElement(node: ReactNode): ReactElement {
  if (!isValidElement(node)) {
    throw new Error(`Expected a ReactElement, got: ${String(node)}`);
  }
  return node;
}

/** ReactElement.props is typed as `unknown`. These typed accessors pull
 *  named props off without scattering type casts at every call site. */
function propString(el: ReactElement, key: string): string {
  const value = readProp(el, key);
  if (typeof value !== 'string') {
    throw new Error(`expected string prop "${key}", got: ${String(value)}`);
  }
  return value;
}

function propBoolean(el: ReactElement, key: string): boolean {
  const value = readProp(el, key);
  if (typeof value !== 'boolean') {
    throw new Error(`expected boolean prop "${key}", got: ${String(value)}`);
  }
  return value;
}

function readProp(el: ReactElement, key: string): unknown {
  const props = el.props;
  if (typeof props !== 'object' || props === null) {
    throw new Error(`expected element props to be an object, got: ${String(props)}`);
  }
  if (!(key in props)) {
    throw new Error(`expected prop "${key}" to be present`);
  }
  return Reflect.get(props, key);
}

/** Render a transcript tool-result and unwrap the <Box> wrapper that
 *  renderExpandedEntry adds around function_call_output entries. */
function unwrapBox(node: ReactNode): ReactElement {
  const box = asElement(node);
  const children = readProp(box, 'children');
  if (!isValidElement(children)) {
    throw new Error('expected Box to wrap a single ReactElement child');
  }
  return children;
}

//#endregion

//#region Pure helpers

describe('mapItemStatus', () => {
  test('maps every documented status code', () => {
    expect(mapItemStatus('completed')).toBe('completed');
    expect(mapItemStatus('in_progress')).toBe('running');
    expect(mapItemStatus('searching')).toBe('running');
    expect(mapItemStatus('generating')).toBe('running');
    expect(mapItemStatus('incomplete')).toBe('error');
    expect(mapItemStatus('failed')).toBe('error');
  });

  test('falls back to pending for unknown / undefined', () => {
    expect(mapItemStatus(undefined)).toBe('pending');
    expect(mapItemStatus('not-a-real-status')).toBe('pending');
  });
});

describe('buildCallInfoMap', () => {
  test('returns empty map for empty input', () => {
    expect(buildCallInfoMap([]).size).toBe(0);
  });

  test('indexes only function_call entries, by callId', () => {
    const map = buildCallInfoMap([
      userEntry('hi'),
      callEntry('Bash', 'in_progress', 'cid-bash'),
      callOutput('cid-bash', 'done'),
      callEntry('Edit', 'completed', 'cid-edit'),
      errorEntry('oops'),
      systemEntry('fyi'),
    ]);
    expect(map.size).toBe(2);
    expect(map.get('cid-bash')).toEqual({
      name: 'Bash',
      status: 'running',
    });
    expect(map.get('cid-edit')).toEqual({
      name: 'Edit',
      status: 'completed',
    });
  });

  test('skips user / error / system entries', () => {
    const map = buildCallInfoMap([
      userEntry('hi'),
      errorEntry('e'),
      systemEntry('s'),
    ]);
    expect(map.size).toBe(0);
  });
});

describe('categorize', () => {
  test('CollapsedReadGroup -> tool-result', () => {
    const group: DisplayEntry = collapsedGroup();
    expect(categorize(group)).toBe('tool-result');
  });
  test('UserEntry -> user', () => {
    expect(categorize(userEntry('hi'))).toBe('user');
  });
  test('ErrorEntry / SystemEntry -> system', () => {
    expect(categorize(errorEntry('e'))).toBe('system');
    expect(categorize(systemEntry('s'))).toBe('system');
  });
  test('message -> assistant-text', () => {
    expect(categorize(assistantMessage('hi'))).toBe('assistant-text');
  });
  test('reasoning -> reasoning', () => {
    expect(categorize(reasoning('think'))).toBe('reasoning');
  });
  test('function_call_output -> tool-result', () => {
    expect(categorize(callOutput('cid', 'x'))).toBe('tool-result');
  });
  test('function_call -> tool-call', () => {
    expect(categorize(callEntry('Bash'))).toBe('tool-call');
  });
});

describe('computeCategories', () => {
  test('maps entries 1:1 in order', () => {
    const cats = computeCategories([
      userEntry('hi'),
      assistantMessage('hello'),
      callEntry('Bash'),
      callOutput('cid-Bash', 'ok'),
    ]);
    expect(cats).toEqual([
      'user',
      'assistant-text',
      'tool-call',
      'tool-result',
    ]);
  });
});

//#endregion

//#region renderEntry — collapsed view dispatch

describe('renderEntry (collapsed view)', () => {
  test('CollapsedReadGroup -> CollapsedReadGroupView', () => {
    const group: DisplayEntry = collapsedGroup();
    const el = asElement(renderEntry(group, 0, makeCtx()));
    expect(el.type).toBe(CollapsedReadGroupView);
  });

  test('UserEntry -> UserPrompt with content passed through', () => {
    const el = asElement(renderEntry(userEntry('hello there', 'u-42'), 0, makeCtx()));
    expect(el.type).toBe(UserPrompt);
    expect(propString(el, 'text')).toBe('hello there');
  });

  test('ErrorEntry mid-assistant-turn renders as sub-response', () => {
    const ctx = makeCtx({
      categories: [
        'assistant-text',
        'system',
      ],
      entryCount: 2,
    });
    const el = asElement(renderEntry(errorEntry('boom'), 1, ctx));
    expect(el.type).toBe(SystemMessage);
    expect(propString(el, 'type')).toBe('error');
    expect(propBoolean(el, 'asResponse')).toBe(true);
  });

  test('SystemEntry -> SystemMessage type=info', () => {
    const el = asElement(renderEntry(systemEntry('fyi'), 0, makeCtx()));
    expect(el.type).toBe(SystemMessage);
    expect(propString(el, 'type')).toBe('info');
  });

  test('empty message -> null', () => {
    expect(renderEntry(emptyMessage(), 0, makeCtx())).toBeNull();
  });

  test('non-empty message -> AssistantText; isStreaming when last+streaming+incomplete', () => {
    const entry: ConversationEntry = {
      id: 'm1',
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [
        {
          type: 'output_text',
          text: 'hello',
        },
      ],
    };
    const ctx = makeCtx({
      chatStatus: 'streaming',
      entryCount: 1,
      categories: [
        'assistant-text',
      ],
    });
    const el = asElement(renderEntry(entry, 0, ctx));
    expect(el.type).toBe(AssistantText);
    expect(propString(el, 'text')).toBe('hello');
    expect(propBoolean(el, 'isStreaming')).toBe(true);
  });

  test('reasoning -> Reasoning, collapsed when status=completed', () => {
    const el = asElement(renderEntry(reasoning('thinking out loud'), 0, makeCtx()));
    expect(el.type).toBe(Reasoning);
    expect(propString(el, 'text')).toBe('thinking out loud');
    expect(propBoolean(el, 'collapsed')).toBe(true);
  });

  test('function_call -> ToolCall with mapped status', () => {
    const el = asElement(renderEntry(callEntry('Bash', 'in_progress'), 0, makeCtx()));
    expect(el.type).toBe(ToolCall);
    expect(propString(el, 'name')).toBe('Bash');
    expect(propString(el, 'status')).toBe('running');
  });

  test('function_call_output dispatches per tool name', () => {
    const callInfoMap = new Map<string, CallInfo>([
      [
        'cid-edit',
        {
          name: 'Edit',
          status: 'completed',
        },
      ],
      [
        'cid-bash',
        {
          name: 'Bash',
          status: 'completed',
        },
      ],
      [
        'cid-lsp',
        {
          name: 'lsp',
          status: 'completed',
        },
      ],
      [
        'cid-other',
        {
          name: 'SomethingElse',
          status: 'completed',
        },
      ],
    ]);
    const ctx = makeCtx({
      callInfoMap,
    });

    expect(asElement(renderEntry(callOutput('cid-edit', '...'), 0, ctx)).type).toBe(EditResult);
    expect(asElement(renderEntry(callOutput('cid-bash', '...'), 0, ctx)).type).toBe(BashResult);
    expect(asElement(renderEntry(callOutput('cid-lsp', '...'), 0, ctx)).type).toBe(LspResult);
    expect(asElement(renderEntry(callOutput('cid-other', '...'), 0, ctx)).type).toBe(ToolResult);
  });
});

//#endregion

//#region renderExpandedEntry — transcript view dispatch

describe('renderExpandedEntry (transcript view)', () => {
  const ctx = {
    callInfoByCallId: new Map<string, CallInfo>(),
  };

  test('UserEntry -> UserPrompt', () => {
    expect(asElement(renderExpandedEntry(userEntry('hello'), 0, ctx)).type).toBe(UserPrompt);
  });

  test('ErrorEntry -> SystemMessage type=error (no sub-response styling)', () => {
    const el = asElement(renderExpandedEntry(errorEntry('boom'), 0, ctx));
    expect(el.type).toBe(SystemMessage);
    expect(propString(el, 'type')).toBe('error');
  });

  test('SystemEntry -> SystemMessage type=info', () => {
    const el = asElement(renderExpandedEntry(systemEntry('fyi'), 0, ctx));
    expect(el.type).toBe(SystemMessage);
    expect(propString(el, 'type')).toBe('info');
  });

  test('message routes by role: user -> UserPrompt, system -> SystemMessage, else -> AssistantText', () => {
    expect(asElement(renderExpandedEntry(userMessage('hi'), 0, ctx)).type).toBe(UserPrompt);
    expect(asElement(renderExpandedEntry(systemMessage('sys'), 0, ctx)).type).toBe(SystemMessage);
    expect(asElement(renderExpandedEntry(assistantMessage('hi'), 0, ctx)).type).toBe(AssistantText);
  });

  test('empty message -> null', () => {
    expect(renderExpandedEntry(emptyMessage(), 0, ctx)).toBeNull();
  });

  test('reasoning -> Reasoning, never collapsed in transcript', () => {
    const el = asElement(renderExpandedEntry(reasoning('thinking'), 0, ctx));
    expect(el.type).toBe(Reasoning);
    expect(propBoolean(el, 'collapsed')).toBe(false);
  });

  test('function_call -> ToolCall with raw args (no preview truncation)', () => {
    const el = asElement(renderExpandedEntry(callEntry('Bash', 'in_progress'), 0, ctx));
    expect(el.type).toBe(ToolCall);
    expect(propString(el, 'args')).toBe('{}');
  });

  test('function_call_output dispatches per tool name (Edit / Bash / lsp)', () => {
    const ctxWithInfo = {
      callInfoByCallId: new Map<string, CallInfo>([
        [
          'cid-edit',
          {
            name: 'Edit',
            status: 'completed',
          },
        ],
        [
          'cid-bash',
          {
            name: 'Bash',
            status: 'completed',
          },
        ],
        [
          'cid-lsp',
          {
            name: 'lsp',
            status: 'completed',
          },
        ],
      ]),
    };
    expect(unwrapBox(renderExpandedEntry(callOutput('cid-edit', 'x'), 0, ctxWithInfo)).type).toBe(
      EditResult,
    );
    expect(unwrapBox(renderExpandedEntry(callOutput('cid-bash', 'x'), 0, ctxWithInfo)).type).toBe(
      BashResult,
    );
    expect(unwrapBox(renderExpandedEntry(callOutput('cid-lsp', 'x'), 0, ctxWithInfo)).type).toBe(
      LspResult,
    );
  });
});

//#endregion
