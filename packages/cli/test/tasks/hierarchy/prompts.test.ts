import { describe, expect, it } from 'bun:test';

import {
  buildTriageUserPrompt,
  buildValidationSystemPrompt,
  INTERVIEW_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
} from '../../../src/tasks/runtime/hierarchy/prompts.js';

describe('INTERVIEW_SYSTEM_PROMPT', () => {
  it('targets the unified task hierarchy shape (TaskHierarchyInput)', () => {
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('milestones');
    // Reference the modern task language, not legacy mission verbiage.
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('Task Hierarchy');
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('"milestones"');
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('assertions');
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('featureIndices');
  });

  it('describes both question and complete envelope shapes', () => {
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('"type": "question"');
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('"type": "complete"');
  });
});

describe('TRIAGE_SYSTEM_PROMPT', () => {
  it('describes PROMPT.md sections including review level scoring', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('### Mission');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('### Steps');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('### Review Level');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('reviewLevel');
  });

  it('keeps fix-task mode wording', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Why the previous attempt failed');
  });
});

describe('buildTriageUserPrompt', () => {
  it('renders feature id, title, description and acceptance bullets', () => {
    const prompt = buildTriageUserPrompt({
      feature: {
        id: 'F-abcdef0123',
        title: 'Wire eventer',
        description: 'Wire X to Y',
        acceptanceCriteria: [
          'Sends events',
          'Stores logs',
        ],
      },
    });
    expect(prompt).toContain('id: F-abcdef0123');
    expect(prompt).toContain('title: Wire eventer');
    expect(prompt).toContain('Wire X to Y');
    expect(prompt).toContain('- Sends events');
    expect(prompt).toContain('- Stores logs');
  });

  it('falls back to placeholders when description and criteria are empty', () => {
    const prompt = buildTriageUserPrompt({
      feature: {
        id: 'F-0000000000',
        title: 't',
        description: '',
        acceptanceCriteria: [],
      },
    });
    expect(prompt).toContain('(none provided)');
    expect(prompt).toContain('infer from description');
  });

  it('emits parent slice verification when present', () => {
    const prompt = buildTriageUserPrompt({
      feature: {
        id: 'F-1111111111',
        title: 't',
        description: 'd',
        acceptanceCriteria: [
          'a',
        ],
      },
      parentSliceVerification: 'all tests pass',
    });
    expect(prompt).toContain('## Parent slice verification');
    expect(prompt).toContain('all tests pass');
  });

  it('switches to fix-task framing when validatorFailure is provided', () => {
    const prompt = buildTriageUserPrompt({
      feature: {
        id: 'F-2222222222',
        title: 't',
        description: 'd',
        acceptanceCriteria: [
          'a',
        ],
      },
      validatorFailure: {
        validatorRunId: 'V-9999999999',
        summary: 'asserter blew up',
        failedAssertions: [
          {
            assertionId: 'A-aaaaaaaaaa',
            statement: 'returns OK',
            message: 'returned ERR',
            expected: 'OK',
            actual: 'ERR',
          },
        ],
        blockedReason: 'env missing',
      },
    });
    expect(prompt).toContain('Why the previous attempt failed');
    expect(prompt).toContain('asserter blew up');
    expect(prompt).toContain('A-aaaaaaaaaa');
    expect(prompt).toContain('expected: OK');
    expect(prompt).toContain('actual: ERR');
    expect(prompt).toContain('### Blocked reason');
    expect(prompt).toContain('env missing');
  });
});

describe('buildValidationSystemPrompt', () => {
  it('renders feature, assertion list, and task context blob', () => {
    const prompt = buildValidationSystemPrompt({
      feature: {
        title: 't',
        description: 'd',
        acceptanceCriteria: [
          'a',
          'b',
        ],
      },
      assertions: [
        {
          id: 'A-abcdefghij',
          statement: 'must work',
        },
      ],
      taskContextBlob: '<context blob>',
    });
    expect(prompt).toContain('## Feature');
    expect(prompt).toContain('- title: t');
    expect(prompt).toContain('- a');
    expect(prompt).toContain('A-abcdefghij');
    expect(prompt).toContain('must work');
    expect(prompt).toContain('<context blob>');
    expect(prompt).toContain('pass');
    expect(prompt).toContain('fail');
    expect(prompt).toContain('blocked');
  });

  it('handles empty acceptance criteria and assertions with placeholders', () => {
    const prompt = buildValidationSystemPrompt({
      feature: {
        title: 't',
        description: '',
        acceptanceCriteria: [],
      },
      assertions: [],
      taskContextBlob: '',
    });
    expect(prompt).toContain('(none provided)');
    expect(prompt).toContain('(no formal assertions');
  });
});
