/**
 * Shared types + schemas for the ask-user tool.
 *
 * Lives outside `ask-user.ts` so the TUI can import the types without pulling
 * in the tool factory (which closes over an `AskUserService`).
 */

import { z } from 'zod';

//#region Schemas

export const AskUserOptionSchema = z.object({
  label: z.string().min(1).describe('The display text for this option. Concise (1–5 words).'),
  description: z
    .string()
    .describe('Explanation of what this option means or what will happen if chosen.'),
  preview: z
    .string()
    .optional()
    .describe(
      'Optional preview content rendered when this option is focused. Markdown (or HTML fragment) for side-by-side visual comparison.',
    ),
});

export const AskUserQuestionSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe('The complete question. Should be clear, specific, and end with a question mark.'),
  header: z
    .string()
    .min(1)
    .max(12)
    .describe('Very short label displayed as a chip/tag (1–12 chars, inclusive).'),
  options: z
    .array(AskUserOptionSchema)
    .min(2)
    .max(4)
    .describe('2–4 distinct choices. An "Other" option is added automatically.'),
  multiSelect: z
    .boolean()
    .default(false)
    .describe('When true, users may select multiple options for this question.'),
});

export const AskUserInputSchema = z.object({
  questions: z
    .array(AskUserQuestionSchema)
    .min(1)
    .max(4)
    .describe('1–4 questions to ask the user.')
    // Question text doubles as the answers-map key. Two questions with the
    // same text would silently collapse, so reject duplicates at parse time.
    .refine((qs) => new Set(qs.map((q) => q.question)).size === qs.length, {
      message: 'Question texts must be unique — duplicates would collapse in the answers map.',
    }),
});

export const AskUserAnnotationSchema = z.object({
  notes: z.string().optional().describe('Free-text notes the user added to their selection.'),
  preview: z
    .string()
    .optional()
    .describe('The preview content of the selected option, if the question used previews.'),
});

export const AskUserOutputSchema = z.object({
  answers: z
    .record(z.string(), z.string())
    .describe('Map from question text to the user\'s answer (label or custom "Other" text).'),
  annotations: z
    .record(z.string(), AskUserAnnotationSchema)
    .optional()
    .describe('Optional per-question annotations (preview content of selected option, notes).'),
});

//#endregion

//#region Types

export type AskUserOption = z.infer<typeof AskUserOptionSchema>;
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;
export type AskUserInput = z.infer<typeof AskUserInputSchema>;
export type AskUserAnnotation = z.infer<typeof AskUserAnnotationSchema>;
export type AskUserOutput = z.infer<typeof AskUserOutputSchema>;

//#endregion
