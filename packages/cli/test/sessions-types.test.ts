import { describe, expect, it } from 'bun:test';
import type { SessionFile } from '../src/sessions/types.js';
import { SessionFileV1Schema, toSessionMetadata } from '../src/sessions/types.js';

function validSession(): SessionFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId: '11111111-2222-4333-8444-555555555555',
    cwd: '/tmp/x',
    effectiveCwd: '/tmp/x',
    model: 'anthropic/claude-sonnet-4',
    agentMode: 'normal',
    createdAt: now,
    modifiedAt: now,
    firstPrompt: 'hello',
    messageCount: 1,
    cumulativeUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    },
    cumulativeCost: 0,
    items: [
      {
        id: 'msg-1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: 'hello',
          },
        ],
      },
    ],
    entries: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  };
}

describe('SessionFileV1Schema', () => {
  it('accepts a minimal valid file', () => {
    expect(() => SessionFileV1Schema.parse(validSession())).not.toThrow();
  });

  it('rejects missing required fields', () => {
    const incomplete = {
      version: 1,
    };
    expect(() => SessionFileV1Schema.parse(incomplete)).toThrow();
  });

  it('rejects a non-UUID sessionId', () => {
    const bad = {
      ...validSession(),
      sessionId: 'not-a-uuid',
    };
    expect(() => SessionFileV1Schema.parse(bad)).toThrow();
  });

  it('rejects a negative cumulativeCost', () => {
    const bad = {
      ...validSession(),
      cumulativeCost: -1,
    };
    expect(() => SessionFileV1Schema.parse(bad)).toThrow();
  });

  it('rejects an invalid agentMode', () => {
    const bad = {
      ...validSession(),
      agentMode: 'supervisor',
    };
    expect(() => SessionFileV1Schema.parse(bad)).toThrow();
  });

  it('accepts an optional tag and customTitle', () => {
    const withOptional = {
      ...validSession(),
      tag: 'mytag',
      customTitle: 'bug triage',
    };
    expect(() => SessionFileV1Schema.parse(withOptional)).not.toThrow();
  });

  it('rejects items without a type discriminant', () => {
    const bad = {
      ...validSession(),
      items: [
        {
          id: 'x',
        },
      ],
    };
    expect(() => SessionFileV1Schema.parse(bad)).toThrow();
  });

  it('accepts a well-formed lastLayerUsage object', () => {
    const withUsage = {
      ...validSession(),
      lastLayerUsage: {
        executionId: 'exec-1',
        modelId: 'anthropic/claude-sonnet-4',
        layers: [],
        systemPromptTokens: 10,
        toolsTokens: 5,
        historyTokens: 20,
        totalUsedTokens: 35,
      },
    };
    expect(() => SessionFileV1Schema.parse(withUsage)).not.toThrow();
  });

  it('rejects a non-object lastLayerUsage (e.g. a number)', () => {
    const bad = {
      ...validSession(),
      lastLayerUsage: 42,
    };
    expect(() => SessionFileV1Schema.parse(bad)).toThrow();
  });
});

describe('toSessionMetadata', () => {
  it('projects out the lite view', () => {
    const file = validSession();
    file.customTitle = 'my-title';
    const meta = toSessionMetadata(file);
    expect(meta.sessionId).toBe(file.sessionId);
    expect(meta.firstPrompt).toBe(file.firstPrompt);
    expect(meta.customTitle).toBe('my-title');
    expect('items' in meta).toBe(false);
    expect('entries' in meta).toBe(false);
  });
});
