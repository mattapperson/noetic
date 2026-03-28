'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { SectionHeader } from '@/components/landing/section-header';
import { TuiWindow } from '@/components/tui/tui-window';
import { CODE_PRE_STYLE } from '@/lib/tui-theme';

const EXAMPLES = {
  ReAct: `import { react, AgentHarness } from '@noetic/core';

const agent = react({
  model: 'gpt-4o',
  tools: [searchTool, calculatorTool],
  maxSteps: 10,
});

const harness = new AgentHarness({
  name: 'react-agent',
  initialStep: agent,
  params: {},
});
const result = await harness.execute('What is 2+2?');`,

  'Ralph Wiggum': `import { ralphWiggum, AgentHarness } from '@noetic/core';

const agent = ralphWiggum({
  model: 'gpt-4o-mini',
  tools: [fetchTool],
  maxIterations: 5,
});

const harness = new AgentHarness({
  name: 'ralph',
  initialStep: agent,
  params: {},
});
const result = await harness.execute('Fetch the latest data');`,

  'Task Tree': `import { adaptivePlan, compilePlan } from '@noetic/core';

const plan = compilePlan({
  goal: 'Research and summarize topic',
  nodes: [
    { id: 'search', tool: 'web_search' },
    { id: 'summarize', deps: ['search'] },
  ],
});

const agent = adaptivePlan(plan, tools);`,
} as const;

type ExampleKey = keyof typeof EXAMPLES;

const TAB_FILENAMES: Record<ExampleKey, string> = {
  ReAct: 'react.ts',
  'Ralph Wiggum': 'ralph-wiggum.ts',
  'Task Tree': 'task-tree.ts',
};

const TABS: ExampleKey[] = [
  'ReAct',
  'Ralph Wiggum',
  'Task Tree',
];

export function CodeExamples(): ReactNode {
  const [activeTab, setActiveTab] = useState<ExampleKey>('ReAct');

  return (
    <section
      style={{
        padding: '80px 24px',
        maxWidth: '720px',
        margin: '0 auto',
      }}
    >
      <SectionHeader
        label="patterns"
        title="Compose Primitives into Patterns"
        margin="8px 0 32px"
      />

      <div
        style={{
          display: 'flex',
          gap: '0',
          marginBottom: '0',
          borderBottom: '1px solid var(--color-tui-border)',
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={(): void => setActiveTab(tab)}
            style={{
              padding: '10px 20px',
              fontSize: '12px',
              fontWeight: activeTab === tab ? 700 : 500,
              color: activeTab === tab ? 'var(--color-tui-green)' : 'var(--color-tui-muted)',
              background: activeTab === tab ? 'var(--color-tui-surface)' : 'transparent',
              border: 'none',
              borderBottom:
                activeTab === tab ? '2px solid var(--color-tui-green)' : '2px solid transparent',
              cursor: 'pointer',
              fontFamily: 'inherit',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              transition: 'color 0.1s',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
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
          <TuiWindow title={TAB_FILENAMES[activeTab]}>
            <pre style={CODE_PRE_STYLE}>{EXAMPLES[activeTab]}</pre>
          </TuiWindow>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
