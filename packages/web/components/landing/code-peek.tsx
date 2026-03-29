'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { TuiWindow } from '@/components/tui/tui-window';
import { CODE_PRE_STYLE } from '@/lib/tui-theme';

const TABS = [
  'ReAct reasoning loop',
  '5-layer memory in 10 lines',
  'Extend any primitive',
] as const;

type Tab = (typeof TABS)[number];

const TAB_FILES: Record<Tab, string> = {
  'ReAct reasoning loop': 'react-loop.ts',
  '5-layer memory in 10 lines': 'memory-setup.ts',
  'Extend any primitive': 'custom-step.ts',
};

const TAB_CODE: Record<Tab, string> = {
  'ReAct reasoning loop': `import { loop, llm, tool, until } from '@noetic/core';

const react = loop([
  llm({ model: 'gpt-4o', tools: [searchTool, calcTool] }),
  tool('search', searchSchema, searchFn),
  tool('calc', calcSchema, calcFn),
], until.toolCallStop());

const result = await execute(react, runtime);
// Observe → Think → Act — just primitives composed`,

  '5-layer memory in 10 lines': `import { InMemoryRuntime } from '@noetic/core';
import {
  WorkingMemoryLayer,
  ObservationalLayer,
  SemanticRecallLayer,
  EpisodicLayer,
  DurableStateLayer,
} from '@noetic/core/memory';

const runtime = new InMemoryRuntime({
  memory: [
    new WorkingMemoryLayer(),
    new ObservationalLayer(),
    new SemanticRecallLayer({ embed }),
    new EpisodicLayer(),
    new DurableStateLayer({ store }),
  ],
});`,

  'Extend any primitive': `import { run } from '@noetic/core';
import type { Context } from '@noetic/core';

interface MyCtx extends Context {
  userId: string;
  sessionId: string;
}

// Custom step: wraps run with your typed context
const logStep = run<MyCtx>((ctx) => {
  ctx.log(\`[\${ctx.sessionId}] user=\${ctx.userId}\`);
});`,
};

export function CodePeek(): ReactNode {
  const [active, setActive] = useState<Tab>('ReAct reasoning loop');

  return (
    <section
      style={{
        padding: '80px 24px',
        maxWidth: '960px',
        margin: '0 auto',
      }}
    >
      <span
        style={{
          fontSize: '13px',
          color: 'var(--color-tui-muted)',
          letterSpacing: '0.1em',
        }}
      >
        {'// read the source'}
      </span>
      <h2
        style={{
          fontSize: '38px',
          fontWeight: 700,
          margin: '8px 0 12px',
          textTransform: 'uppercase',
          letterSpacing: '-0.01em',
        }}
      >
        Reasoning loop in 15 lines, full memory stack in 10. No boilerplate.
      </h2>
      <p
        style={{
          fontSize: '14px',
          color: 'var(--color-tui-muted)',
          margin: '0 0 32px',
          lineHeight: 1.7,
        }}
      >
        It&apos;s the same seven primitives from before. Once you know those, you can read — and
        change — anything.
      </p>

      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid var(--color-tui-border)',
          flexWrap: 'wrap',
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={(): void => setActive(tab)}
            style={{
              padding: '10px 16px',
              fontSize: '11px',
              fontWeight: active === tab ? 700 : 500,
              color: active === tab ? 'var(--color-tui-green)' : 'var(--color-tui-muted)',
              background: active === tab ? 'var(--color-tui-surface)' : 'transparent',
              border: 'none',
              borderBottom:
                active === tab ? '2px solid var(--color-tui-green)' : '2px solid transparent',
              cursor: 'pointer',
              fontFamily: 'inherit',
              letterSpacing: '0.04em',
              transition: 'color 0.1s',
              whiteSpace: 'nowrap',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={active}
          initial={{
            opacity: 0,
            y: 8,
          }}
          animate={{
            opacity: 1,
            y: 0,
          }}
          exit={{
            opacity: 0,
            y: -8,
          }}
          transition={{
            duration: 0.15,
          }}
        >
          <TuiWindow title={TAB_FILES[active]}>
            <pre style={CODE_PRE_STYLE}>{TAB_CODE[active]}</pre>
          </TuiWindow>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
