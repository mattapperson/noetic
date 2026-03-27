/**
 * Branching Support Ticket Router
 *
 * Demonstrates: branch + step.run + step.llm + loop
 *
 * Classifies incoming support tickets by keyword and routes them:
 * - Billing keywords → deterministic step.run response
 * - Technical keywords → step.llm for reasoning
 * - Everything else → step.run fallback
 *
 * Wrapped in loop({ until: until.maxSteps(1) }) to show branch inside a loop body.
 */
import { branch } from '../src/builders/control-flow-builders';
import { loop } from '../src/builders/loop-builder';
import { step } from '../src/builders/step-builders';
import type { StepLoop } from '../src/types/step';
import { until } from '../src/until/predicates';

//#region Keyword Sets

const BILLING_KEYWORDS = [
  'invoice',
  'charge',
  'refund',
  'billing',
  'payment',
  'subscription',
];
const TECHNICAL_KEYWORDS = [
  'error',
  'bug',
  'crash',
  'broken',
  'fix',
  'debug',
  'logs',
];

//#endregion

//#region Handlers

function containsKeyword(input: string, keywords: readonly string[]): boolean {
  const lower = input.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

const billingHandler = step.run<string, string>({
  id: 'billing-handler',
  execute: async (input) => {
    return [
      'Billing Support Response:',
      `Your ticket: "${input}"`,
      '',
      'Please visit your account dashboard at /billing to review charges.',
      'For refunds, allow 5-7 business days after approval.',
      'A billing specialist will follow up within 24 hours.',
    ].join('\n');
  },
});

const technicalHandler = step.llm<string, string>({
  id: 'technical-handler',
  model: 'gpt-4o',
  system: [
    'You are a technical support specialist.',
    'Analyze the issue described and provide a concise troubleshooting response.',
    'Include 2-3 specific steps the user can try.',
  ].join(' '),
});

const fallbackHandler = step.run<string, string>({
  id: 'fallback-handler',
  execute: async (input) => {
    return [
      'General Support Response:',
      `We received your ticket: "${input}"`,
      '',
      'Your request has been forwarded to the appropriate team.',
      'Expected response time: 48 hours.',
    ].join('\n');
  },
});

//#endregion

//#region Agent Builder

/** Builds a support ticket router using branch + loop. */
export function buildBranchingAgent(): StepLoop<string, string> {
  const router = branch<string, string>({
    id: 'ticket-router',
    route: (input) => {
      if (containsKeyword(input, BILLING_KEYWORDS)) {
        return billingHandler;
      }
      if (containsKeyword(input, TECHNICAL_KEYWORDS)) {
        return technicalHandler;
      }
      return fallbackHandler;
    },
  });

  return loop({
    id: 'ticket-processing-loop',
    steps: [
      router,
    ],
    until: until.maxSteps(1),
  });
}

//#endregion
