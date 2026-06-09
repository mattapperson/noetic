'use client';

import type { ReactNode } from 'react';
import { SectionHeader } from '@/components/landing/section-header';
import { TuiWindow } from '@/components/tui/tui-window';

const EVAL_MOCKUP = `  EVAL RUN: agent-quality-v3
  ─────────────────────────────────

  ✓ PASS  responds to greeting          12ms
  ✓ PASS  uses search tool correctly    340ms
  ✗ FAIL  handles ambiguous query       280ms
  ✓ PASS  stays within token budget     890ms
  ✓ PASS  cites sources accurately      450ms

  Results: 4/5 passed (80%)

  GEPA OPTIMIZE ━━━━━━━━━━━━━ +12% accuracy
  baseline saved · regression gate: pass`;

export function EvalFramework(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        margin: '0 auto',
      }}
    >
      <SectionHeader label="ship with confidence" title="Eval Framework" margin="8px 0 12px" />
      <p
        style={{
          fontSize: '17px',
          color: 'var(--color-tui-secondary)',
          margin: '0 0 8px',
          lineHeight: 1.5,
        }}
      >
        Write evals as easily as Jest tests, then let the optimizer make your agent better.
      </p>
      <p
        style={{
          fontSize: '14px',
          color: 'var(--color-tui-muted)',
          margin: '0 0 32px',
          lineHeight: 1.7,
        }}
      >
        Define what &quot;good&quot; looks like for your agent, run it against a dataset, and let
        GEPA optimization improve it. Gate regressions in CI. Same primitives. Same runtime. Just a
        feedback loop added.
      </p>

      <TuiWindow title="eval-framework">
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
