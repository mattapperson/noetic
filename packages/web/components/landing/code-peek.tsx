'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { TuiWindow } from '@/components/tui/tui-window';
import { highlightCode } from '@/lib/syntax-highlight';
import { CODE_PRE_STYLE } from '@/lib/tui-theme';

const TABS = [
  'ReAct reasoning loop',
  '5-layer memory in 10 lines',
  'Sandboxed harness',
  'Extend any primitive',
] as const;

type Tab = (typeof TABS)[number];

const TAB_FILES: Record<Tab, string> = {
  'ReAct reasoning loop': 'react-loop.ts',
  '5-layer memory in 10 lines': 'memory-setup.ts',
  'Sandboxed harness': 'harness-adapters.ts',
  'Extend any primitive': 'custom-step.ts',
};

const TAB_CODE: Record<Tab, string> = {
  'ReAct reasoning loop': `import { any, loop, step, until } from '@noetic-tools/core';

const reasonAndAct = loop({
  id: 'react-loop',
  steps: [
    step.llm({
      id: 'think',
      model: 'gpt-4o',
      tools: [searchTool, calcTool],
    }),
  ],
  until: any(until.noToolCalls(), until.maxSteps(10)),
});
// Observe → Think → Act — just primitives composed`,

  '5-layer memory in 10 lines': `import {
  AgentHarness,
  durableTaskState,
  observationalMemory,
  planMemory,
  workingMemory,
} from '@noetic-tools/core';

const harness = new AgentHarness({
  name: 'agent',
  initialStep: agent,
  params: {},
  memory: [
    workingMemory({ scope: 'thread' }),
    observationalMemory({ bufferThreshold: 4_000, observer }),
    planMemory({ maxTreeDepth: 3 }),
    durableTaskState({ baseDir: '.noetic/tasks' }),
    semanticRecall,
  ],
});`,

  'Sandboxed harness': `import { AgentHarness } from '@noetic-tools/core';
import type { FsAdapter, ShellAdapter } from '@noetic-tools/core';

// Swap any of these for an in-memory, remote, or sandboxed backend.
const fs: FsAdapter = createSandboxFs({ root: '/work' });
const shell: ShellAdapter = {
  exec: async (command, opts) => runInContainer(command, opts),
};

const harness = new AgentHarness({
  name: 'sandboxed-agent',
  initialStep: agent,
  params: {},
  fs,           // tools, skill discovery, memory layers all route here
  shell,        // every sub-process the agent spawns goes through this
  initialCwd: '/work',
  llm: { provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY },
});`,

  'Extend any primitive': `import { step } from '@noetic-tools/core';
import type { Context } from '@noetic-tools/core';

interface SessionMemory {
  userId: string;
  sessionId: string;
}

const logStep = step.run<SessionMemory, string, void>({
  id: 'audit-log',
  execute: async (input, ctx: Context<SessionMemory>) => {
    console.log(\`[\${ctx.memory.sessionId}] user=\${ctx.memory.userId} msg=\${input}\`);
  },
});`,
};

export function CodePeek(): ReactNode {
  const [active, setActive] = useState<Tab>('ReAct reasoning loop');

  return (
    <section
      style={{
        padding: '80px 24px',
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
            <pre style={CODE_PRE_STYLE}>{highlightCode(TAB_CODE[active])}</pre>
          </TuiWindow>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
