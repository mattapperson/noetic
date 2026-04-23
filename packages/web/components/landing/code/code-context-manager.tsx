'use client';

import type { ReactNode } from 'react';
import { LayerTile } from '@/components/landing/layer-tile';
import { LegendRow } from '@/components/landing/legend-row';
import { SectionBody } from '@/components/landing/section-body';
import { SectionHeader } from '@/components/landing/section-header';
import { TuiReadout } from '@/components/tui/tui-readout';

type LayerTone = 'working' | 'retrieval' | 'persistence' | 'control';

interface LayerCard {
  name: string;
  description: string;
  tone: LayerTone;
}

const TONE_COLOR: Record<LayerTone, string> = {
  working: 'var(--color-tui-cyan)',
  retrieval: 'var(--color-tui-green)',
  persistence: 'var(--color-tui-amber)',
  control: 'var(--color-tui-muted)',
};

const LAYERS: LayerCard[] = [
  {
    name: 'Working Memory',
    description: 'Scratchpad for the current turn. Forgotten on the next.',
    tone: 'working',
  },
  {
    name: 'Observational Memory',
    description: 'Auto-extracted facts from what just happened.',
    tone: 'working',
  },
  {
    name: 'Static Content',
    description: 'Project rules, style guides, invariants that do not change.',
    tone: 'working',
  },
  {
    name: 'Tool Memory',
    description: 'Per-tool state — bash shell history, LSP diagnostics, open files.',
    tone: 'working',
  },
  {
    name: 'File Reference',
    description: 'Tracks which files the agent has opened, edited, or staged.',
    tone: 'working',
  },
  {
    name: 'Semantic Recall',
    description: 'Vector-indexed long-term memory. Pulls only what is relevant.',
    tone: 'retrieval',
  },
  {
    name: 'Episodic Memory',
    description: 'Summaries of past conversations, indexed by task and outcome.',
    tone: 'retrieval',
  },
  {
    name: 'Plan Memory',
    description: 'PRDs, task breakdowns, and checkpointed progress across the run.',
    tone: 'retrieval',
  },
  {
    name: 'Durable Task State',
    description: 'Persistent artifacts that survive restarts and process crashes.',
    tone: 'persistence',
  },
  {
    name: 'Steering',
    description: 'Governance layer. Redirects or blocks unsafe tool calls before they run.',
    tone: 'control',
  },
];

const LEGEND = [
  {
    color: TONE_COLOR.working,
    label: 'working layers',
  },
  {
    color: TONE_COLOR.retrieval,
    label: 'retrieval layers',
  },
  {
    color: TONE_COLOR.persistence,
    label: 'persistence',
  },
  {
    color: TONE_COLOR.control,
    label: 'control',
  },
] as const;

export function CodeContextManager(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        margin: '0 auto',
      }}
    >
      <div
        className="section-split"
        style={{
          marginBottom: '48px',
        }}
      >
        <div>
          <SectionHeader label="context manager" title="Ten layers, one mind" margin="8px 0 12px" />
          <SectionBody
            lede="Most coding agents have one trick for memory: cram it all in, pray the model finds it."
            detail="Noetic Code ships ten specialized memory layers. Each one has its own lifecycle, scope, and budget. The agent pulls what it needs, when it needs it. Your context window stays predictable no matter how long the session runs."
          />
        </div>

        <TuiReadout gap="12px" color="var(--color-tui-muted)">
          <div
            style={{
              color: 'var(--color-tui-green)',
            }}
          >
            {'$ noetic --memory-budget'}
          </div>
          <div>{'working       ████████░░  1,842 / 2,400 tok'}</div>
          <div>{'observations  ███░░░░░░░    612 / 2,000 tok'}</div>
          <div>{'semantic      █████░░░░░  4,021 / 8,000 tok'}</div>
          <div>{'episodic      ██░░░░░░░░    401 / 2,000 tok'}</div>
          <div>{'plan          █████████░  2,880 / 3,000 tok'}</div>
          <div
            style={{
              color: 'var(--color-tui-green)',
              marginTop: '4px',
            }}
          >
            {'total         ████░░░░░░  9,756 / 17,400 tok  (56%)'}
          </div>
        </TuiReadout>
      </div>

      <LegendRow items={LEGEND} />

      <div
        className="memory-layers-grid"
        style={{
          display: 'grid',
          gap: '4px',
        }}
      >
        {LAYERS.map((layer, i) => (
          <LayerTile
            key={layer.name}
            name={layer.name}
            description={layer.description}
            color={TONE_COLOR[layer.tone]}
            delay={i * 0.05}
          />
        ))}
      </div>
    </section>
  );
}
