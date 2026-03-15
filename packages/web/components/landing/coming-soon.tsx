'use client';

import type { ReactNode } from 'react';
import { TuiBadge } from '@/components/tui/tui-badge';
import { TuiWindow } from '@/components/tui/tui-window';

const EVAL_MOCKUP = `  EVAL RUN: agent-quality-v3
  ─────────────────────────────────

  ✓ PASS  responds to greeting          12ms
  ✓ PASS  uses search tool correctly    340ms
  ✗ FAIL  handles ambiguous query       280ms
  ✓ PASS  stays within token budget     890ms
  ✓ PASS  cites sources accurately      450ms

  Results: 4/5 passed (80%)

  RL PIPELINE ━━━━━━━━━━━━━━━ READY
  reward signal: accuracy + cost
  policy update: pending`;

export function ComingSoon(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        maxWidth: '640px',
        margin: '0 auto',
      }}
    >
      <TuiWindow title="eval-framework">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '16px',
          }}
        >
          <TuiBadge color="amber">Coming Soon</TuiBadge>
          <span
            style={{
              fontSize: '14px',
              fontWeight: 600,
              letterSpacing: '0.05em',
            }}
          >
            Eval Framework + RL Pipeline
          </span>
        </div>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--color-tui-secondary)',
            margin: '0 0 16px',
            lineHeight: 1.6,
          }}
        >
          Write evals as easily as Jest tests. Train agents with reinforcement learning.
        </p>
        <pre
          style={{
            margin: 0,
            fontSize: '12px',
            lineHeight: 1.6,
            color: 'var(--color-tui-muted)',
            overflow: 'auto',
          }}
        >
          {EVAL_MOCKUP}
        </pre>
      </TuiWindow>
    </section>
  );
}
