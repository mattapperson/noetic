/**
 * Tests for the resume-and-compose flow:
 *   1. `composeRuntimeModel` precedence across CLI / session / config-file / default.
 *   2. `resumedItemsRef` freshness contract (preserved via `stripUnresolvedToolCalls`).
 *   3. `--session-id <uuid>` accepted standalone (no `-c`/`-r` required).
 *
 * `OPENROUTER_API_KEY` is defaulted by `test/setup.ts` preload, so `parseArgs`
 * can be called directly here.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Item } from '@noetic/core';

import { parseArgs } from '../src/cli/args.js';
import { composeRuntimeModel } from '../src/cli/compose-runtime-config.js';
import { stripUnresolvedToolCalls } from '../src/sessions/strip-unresolved.js';

function cli(...extra: string[]): ReturnType<typeof parseArgs> {
  return parseArgs([
    'bun',
    'cli.ts',
    ...extra,
  ]);
}

describe('composeRuntimeModel precedence', () => {
  it('uses CLI --model when user explicitly passed it (beats everything)', () => {
    const result = composeRuntimeModel({
      cliModel: 'openai/gpt-4o',
      modelExplicit: true,
      sessionModel: 'anthropic/claude-opus-4',
      configFileModel: 'anthropic/claude-sonnet-4',
    });
    expect(result).toBe('openai/gpt-4o');
  });

  it('falls back to session model when --model was not explicit', () => {
    const result = composeRuntimeModel({
      cliModel: 'anthropic/claude-sonnet-4',
      modelExplicit: false,
      sessionModel: 'anthropic/claude-opus-4',
      configFileModel: 'openai/gpt-4o',
    });
    expect(result).toBe('anthropic/claude-opus-4');
  });

  it('falls back to config-file model when no session is being resumed', () => {
    const result = composeRuntimeModel({
      cliModel: 'anthropic/claude-sonnet-4',
      modelExplicit: false,
      sessionModel: undefined,
      configFileModel: 'openai/gpt-4o',
    });
    expect(result).toBe('openai/gpt-4o');
  });

  it('falls back to the CLI default when nothing else is present', () => {
    const result = composeRuntimeModel({
      cliModel: 'anthropic/claude-sonnet-4',
      modelExplicit: false,
      sessionModel: undefined,
      configFileModel: undefined,
    });
    expect(result).toBe('anthropic/claude-sonnet-4');
  });

  it('treats empty-string session/config model as "not set"', () => {
    const result = composeRuntimeModel({
      cliModel: 'anthropic/claude-sonnet-4',
      modelExplicit: false,
      sessionModel: '',
      configFileModel: '',
    });
    expect(result).toBe('anthropic/claude-sonnet-4');
  });
});

describe('parseArgs — modelExplicit tracks --model', () => {
  it('sets modelExplicit=false when --model is not passed', () => {
    expect(cli().flags.modelExplicit).toBe(false);
  });

  it('sets modelExplicit=true when --model is passed', () => {
    const result = cli('--model', 'openai/gpt-4o');
    expect(result.flags.modelExplicit).toBe(true);
    expect(result.config.model).toBe('openai/gpt-4o');
  });
});

describe('resumedItemsRef freshness — stripUnresolvedToolCalls shape', () => {
  // Pins the contract behind `onTurnSettled`'s ref refresh: a merged pre+post
  // turn item list survives `stripUnresolvedToolCalls` intact, so a subsequent
  // `/model` or `/plan` harness swap reseeds with the latest history.
  it('keeps both pre-resume and post-resume ids after the ref is refreshed', () => {
    const preResumeItems: Item[] = [
      {
        id: 'msg-pre-1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: 'hello (pre-resume)',
          },
        ],
      },
      {
        id: 'msg-pre-2',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'hi back (pre-resume)',
            annotations: [],
          },
        ],
      },
    ];

    const postTurnItems: Item[] = [
      ...preResumeItems,
      {
        id: 'msg-post-1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: 'another question',
          },
        ],
      },
      {
        id: 'msg-post-2',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'another answer',
            annotations: [],
          },
        ],
      },
    ];

    const refreshed = stripUnresolvedToolCalls(postTurnItems);
    // `id` is present on every Item variant we create here, but the SDK's
    // ServerToolItem lacks it in the union, so tsc requires the `in` guard.
    const ids = refreshed.map((item) => ('id' in item ? item.id : undefined));
    expect(ids).toContain('msg-pre-1');
    expect(ids).toContain('msg-pre-2');
    expect(ids).toContain('msg-post-1');
    expect(ids).toContain('msg-post-2');
  });

  it('still drops a dangling function_call after the refresh path', () => {
    const items: Item[] = [
      {
        id: 'msg-1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: 'do a thing',
          },
        ],
      },
      {
        id: 'call-1',
        type: 'function_call',
        callId: 'call-dangling',
        name: 'bash',
        arguments: '{"command":"echo hi"}',
        status: 'completed',
      },
    ];
    const cleaned = stripUnresolvedToolCalls(items);
    expect(cleaned).toHaveLength(1);
    const [first] = cleaned;
    assert(first !== undefined);
    expect(first.type).toBe('message');
  });
});

describe('--session-id alone is honored', () => {
  it('parses --session-id without --continue/--resume and carries it in flags', () => {
    const uuid = 'abcdabcd-0000-4000-8000-000000000011';
    const result = cli('--session-id', uuid);
    expect(result.flags.sessionId).toBe(uuid);
    expect(result.flags.continueLatest).toBe(false);
    expect(result.flags.resume).toBe(false);
    expect(result.flags.forkSession).toBe(false);
  });

  it('coexists with --no-session-persistence', () => {
    const uuid = 'abcdabcd-0000-4000-8000-000000000022';
    const result = cli('--session-id', uuid, '--no-session-persistence');
    expect(result.flags.sessionId).toBe(uuid);
    expect(result.flags.noSessionPersistence).toBe(true);
  });
});
