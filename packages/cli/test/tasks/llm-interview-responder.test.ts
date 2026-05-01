import { describe, expect, it } from 'bun:test';

import type { InterviewQuestionEnvelope } from '../../src/commands/builtins/tasks/hierarchy/live-interview.js';
import {
  buildAnswerPrompt,
  buildResponderVerdict,
  buildRetryPrompt,
  formatParseError,
} from '../../src/commands/builtins/tasks/llm-interview-responder.js';

function makeEnvelope(
  overrides: Partial<InterviewQuestionEnvelope> = {},
): InterviewQuestionEnvelope {
  return {
    id: 'q1',
    type: 'single_select',
    question: 'How big is this task?',
    options: [
      {
        id: 'small',
        label: 'Small',
      },
      {
        id: 'large',
        label: 'Large',
      },
    ],
    ...overrides,
  };
}

describe('buildAnswerPrompt', () => {
  it('includes the description block when description is non-empty', () => {
    const out = buildAnswerPrompt({
      envelope: makeEnvelope(),
      taskTitle: 'Add hello-qa script',
      taskDescription: 'Print "hello QA" when run with bun.',
    });
    expect(out).toContain('Title: Add hello-qa script');
    expect(out).toContain('Description:');
    expect(out).toContain('Print "hello QA" when run with bun.');
  });

  it('omits the description block when description is empty', () => {
    const out = buildAnswerPrompt({
      envelope: makeEnvelope(),
      taskTitle: 'Solo title',
      taskDescription: '',
    });
    expect(out).toContain('Title: Solo title');
    expect(out).not.toContain('Description:');
  });

  it('renders single_select options inline with id and label', () => {
    const out = buildAnswerPrompt({
      envelope: makeEnvelope({
        type: 'single_select',
        options: [
          {
            id: 'a',
            label: 'Alpha',
            description: 'first letter',
          },
          {
            id: 'b',
            label: 'Beta',
          },
        ],
      }),
      taskTitle: 't',
      taskDescription: '',
    });
    expect(out).toContain('id="a" label="Alpha" — first letter');
    expect(out).toContain('id="b" label="Beta"');
    expect(out).toContain('Return `answer` as a single string');
  });

  it('emits the array-answer instruction for multi_select', () => {
    const out = buildAnswerPrompt({
      envelope: makeEnvelope({
        type: 'multi_select',
        options: [
          {
            id: 'a',
            label: 'A',
          },
          {
            id: 'b',
            label: 'B',
          },
        ],
      }),
      taskTitle: 't',
      taskDescription: '',
    });
    expect(out).toContain('Return `answer` as an array');
  });

  it('emits the single-string instruction for confirm and text questions', () => {
    const confirm = buildAnswerPrompt({
      envelope: {
        id: 'qc',
        type: 'confirm',
        question: 'Proceed?',
      },
      taskTitle: 't',
      taskDescription: '',
    });
    expect(confirm).toContain('Return `answer` as a single string');
    const text = buildAnswerPrompt({
      envelope: {
        id: 'qt',
        type: 'text',
        question: 'Describe?',
      },
      taskTitle: 't',
      taskDescription: '',
    });
    expect(text).toContain('Return `answer` as a single string');
  });

  it('echoes the questionId so the responder can correlate the answer', () => {
    const out = buildAnswerPrompt({
      envelope: makeEnvelope({
        id: 'q-correlate-me',
      }),
      taskTitle: 't',
      taskDescription: '',
    });
    expect(out).toContain('questionId: q-correlate-me');
  });

  it('renders the optional description on the envelope', () => {
    const out = buildAnswerPrompt({
      envelope: makeEnvelope({
        description: 'extra context for the question',
      }),
      taskTitle: 't',
      taskDescription: '',
    });
    expect(out).toContain('description: extra context for the question');
  });
});

describe('buildResponderVerdict', () => {
  it('passes when result is ok with a value', async () => {
    const verdict = buildResponderVerdict({
      ok: true,
      value: {
        questionId: 'q1',
        question: 'Q?',
        answer: 'a',
      },
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.feedback).toBeUndefined();
  });

  it('fails with the error as feedback when result is not ok', () => {
    const verdict = buildResponderVerdict({
      ok: false,
      error: 'expected string, got number',
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.feedback).toBe('expected string, got number');
  });

  it('fails with a placeholder error when output is unrecognised', () => {
    const verdict = buildResponderVerdict('not a responder result');
    expect(verdict.pass).toBe(false);
    expect(verdict.feedback).toBe('unknown');
  });

  it('fails when ok is true but value is missing', () => {
    const verdict = buildResponderVerdict({
      ok: true,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.feedback).toContain('unknown parse error');
  });

  it('fails for null', () => {
    const verdict = buildResponderVerdict(null);
    expect(verdict.pass).toBe(false);
    expect(verdict.feedback).toBe('unknown');
  });
});

describe('buildRetryPrompt', () => {
  it('appends the feedback under a retry header', () => {
    const out = buildRetryPrompt({
      basePrompt: '# Task\nTitle: Foo',
      feedback: 'expected string at .answer; got number',
    });
    expect(out).toContain('# Task\nTitle: Foo');
    expect(out).toContain('## Prior attempt rejected by the parser');
    expect(out).toContain('expected string at .answer; got number');
    expect(out).toContain('Re-emit valid JSON');
  });
});

describe('formatParseError', () => {
  it('joins the zod message and the raw output', () => {
    const out = formatParseError('answer: Required', '{"questionId":"q1"}');
    expect(out).toContain('answer: Required');
    expect(out).toContain('--- raw output ---');
    expect(out).toContain('{"questionId":"q1"}');
  });

  it('truncates very long raw output', () => {
    const longRaw = 'x'.repeat(2_000);
    const out = formatParseError('schema mismatch', longRaw);
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(longRaw.length);
  });
});
