/**
 * Tests for the ask-user tool: schema validation boundaries and execution
 * semantics against a fake AskUserService.
 */

import { describe, expect, test } from 'bun:test';
import type { AskUserService } from '@noetic/code-agent/ask-user-service';
import { AskUserBusyError, createAskUserService } from '@noetic/code-agent/ask-user-service';
import type { AskUserInput, ToolExecutionContext } from '@noetic/core';
import { AskUserInputSchema, AskUserOutputSchema, isNoeticError } from '@noetic/core';
import { createAskUserTool } from '../src/tools/ask-user.js';

// Minimal stub — our ask-user tool's execute body doesn't read from ctx, so
// the rest can be opaque. The `Object.create(null)` cast avoids touching
// the heavy ToolExecutionContext type tree; if a future change starts using
// ctx fields the test will throw on first access.
function makeStubExecutionContext(): ToolExecutionContext {
  const empty: ToolExecutionContext = Object.create(null);
  return empty;
}

function makeInput(): AskUserInput {
  return {
    questions: [
      {
        question: 'Library?',
        header: 'Lib',
        multiSelect: false,
        options: [
          {
            label: 'A',
            description: 'a',
          },
          {
            label: 'B',
            description: 'b',
          },
        ],
      },
    ],
  };
}

describe('AskUserInputSchema', () => {
  test('accepts 1 question with 2 options', () => {
    const parsed = AskUserInputSchema.safeParse({
      questions: [
        {
          question: 'Library?',
          header: 'Lib',
          multiSelect: false,
          options: [
            {
              label: 'A',
              description: 'a',
            },
            {
              label: 'B',
              description: 'b',
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test('rejects 0 questions', () => {
    const parsed = AskUserInputSchema.safeParse({
      questions: [],
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects 5 questions', () => {
    const makeQ = (n: number): unknown => ({
      question: `Q${n}?`,
      header: `H${n}`,
      multiSelect: false,
      options: [
        {
          label: 'A',
          description: 'a',
        },
        {
          label: 'B',
          description: 'b',
        },
      ],
    });
    const parsed = AskUserInputSchema.safeParse({
      questions: [
        makeQ(1),
        makeQ(2),
        makeQ(3),
        makeQ(4),
        makeQ(5),
      ],
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects header longer than 12 characters', () => {
    const parsed = AskUserInputSchema.safeParse({
      questions: [
        {
          question: 'Q?',
          header: 'thirteen-char',
          multiSelect: false,
          options: [
            {
              label: 'A',
              description: 'a',
            },
            {
              label: 'B',
              description: 'b',
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects 1 option', () => {
    const parsed = AskUserInputSchema.safeParse({
      questions: [
        {
          question: 'Q?',
          header: 'H',
          multiSelect: false,
          options: [
            {
              label: 'A',
              description: 'a',
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects 5 options', () => {
    const parsed = AskUserInputSchema.safeParse({
      questions: [
        {
          question: 'Q?',
          header: 'H',
          multiSelect: false,
          options: [
            {
              label: 'A',
              description: 'a',
            },
            {
              label: 'B',
              description: 'b',
            },
            {
              label: 'C',
              description: 'c',
            },
            {
              label: 'D',
              description: 'd',
            },
            {
              label: 'E',
              description: 'e',
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  test('accepts 4 questions with 4 options (upper boundary)', () => {
    const makeQ = (n: number): unknown => ({
      question: `Q${n}?`,
      header: `H${n}`,
      multiSelect: false,
      options: [
        {
          label: 'A',
          description: 'a',
        },
        {
          label: 'B',
          description: 'b',
        },
        {
          label: 'C',
          description: 'c',
        },
        {
          label: 'D',
          description: 'd',
        },
      ],
    });
    const parsed = AskUserInputSchema.safeParse({
      questions: [
        makeQ(1),
        makeQ(2),
        makeQ(3),
        makeQ(4),
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('AskUserOutputSchema', () => {
  test('accepts plain answers map', () => {
    expect(
      AskUserOutputSchema.safeParse({
        answers: {
          'Q?': 'Yes',
        },
      }).success,
    ).toBe(true);
  });

  test('accepts answers + annotations', () => {
    const parsed = AskUserOutputSchema.safeParse({
      answers: {
        'Q?': 'Yes',
      },
      annotations: {
        'Q?': {
          preview: '# yes',
          notes: 'keeps it simple',
        },
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('createAskUserTool', () => {
  test('registers with the right name and shares the supplied schemas', () => {
    const service: AskUserService = createAskUserService();
    const tool = createAskUserTool(service);
    expect(tool.name).toBe('AskUserQuestion');
    expect(tool.input).toBe(AskUserInputSchema);
    expect(tool.output).toBe(AskUserOutputSchema);
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(20);
  });

  test('execute resolves with the output once the service resolves', async () => {
    const service = createAskUserService();
    const tool = createAskUserTool(service);
    const exec = tool.execute(makeInput(), makeStubExecutionContext());
    const current = service.peek();
    expect(current).not.toBeNull();
    service.resolve(current!.id, {
      answers: {
        'Library?': 'A',
      },
    });
    await expect(exec).resolves.toEqual({
      answers: {
        'Library?': 'A',
      },
    });
  });

  test('execute rejects with a NoeticError(cancelled) when the service cancels', async () => {
    const service = createAskUserService();
    const tool = createAskUserTool(service);
    const exec = tool.execute(makeInput(), makeStubExecutionContext());
    const current = service.peek();
    expect(current).not.toBeNull();
    service.cancel(current!.id, 'user dismissed');
    let caught: unknown;
    try {
      await exec;
    } catch (e) {
      caught = e;
    }
    expect(isNoeticError(caught)).toBe(true);
    if (isNoeticError(caught)) {
      expect(caught.noeticError.kind).toBe('cancelled');
    }
  });

  test('execute rejects the second concurrent call with AskUserBusyError', async () => {
    const service = createAskUserService();
    const tool = createAskUserTool(service);
    const first = tool.execute(makeInput(), makeStubExecutionContext());
    let caught: unknown;
    try {
      await tool.execute(makeInput(), makeStubExecutionContext());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AskUserBusyError);
    if (caught instanceof AskUserBusyError) {
      expect(caught.kind).toBe('ask-user-busy');
    }
    // Drain the first request so the test ends cleanly.
    const current = service.peek();
    service.cancel(current!.id, 'cleanup');
    await expect(first).rejects.toBeDefined();
  });
});

describe('AskUserInputSchema duplicate-question guard', () => {
  test('rejects two questions with identical text', () => {
    const parsed = AskUserInputSchema.safeParse({
      questions: [
        {
          question: 'Same?',
          header: 'A',
          multiSelect: false,
          options: [
            {
              label: 'A',
              description: 'a',
            },
            {
              label: 'B',
              description: 'b',
            },
          ],
        },
        {
          question: 'Same?',
          header: 'B',
          multiSelect: false,
          options: [
            {
              label: 'A',
              description: 'a',
            },
            {
              label: 'B',
              description: 'b',
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
