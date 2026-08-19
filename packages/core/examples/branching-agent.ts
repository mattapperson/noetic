/**
 * Branching Support Ticket Router
 *
 * Demonstrates: conditional + runCode + callModel + loop
 *
 * Classifies incoming support tickets by keyword and routes them:
 * - Billing keywords → deterministic runCode response
 * - Technical keywords → callModel for reasoning
 * - Everything else → runCode fallback
 *
 * Wrapped in loop({ until: until.maxSteps(1) }) to show conditional inside a loop body.
 */

import type { ContextData } from '@noetic-tools/context';
import type { StepLoop } from '@noetic-tools/types';
import { conditional } from '../src/builders/control-flow-builders';
import { loop } from '../src/builders/loop-builder';
import { callModel, runCode } from '../src/builders/step-builders';
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

const billingHandler = runCode<ContextData, string, string>({
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

const technicalHandler = callModel<ContextData, string, string>({
  id: 'technical-handler',
  model: 'openai/gpt-4o',
  instructions: [
    'You are a technical support specialist.',
    'Analyze the issue described and provide a concise troubleshooting response.',
    'Include 2-3 specific steps the user can try.',
  ].join(' '),
});

const fallbackHandler = runCode<ContextData, string, string>({
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

/** Builds a support ticket router using conditional + loop. */
export function buildBranchingAgent(): StepLoop<ContextData, string, string> {
  const router = conditional<ContextData, string, string>({
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
