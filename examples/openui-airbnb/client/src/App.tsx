/**
 * App orchestration. Owns no UI *design* state — it holds the accumulated OpenUI
 * Lang the agent has streamed, parses it with noetic's real `parseDocument`, and
 * projects it through the renderer. A prompt (or a card interaction) starts a
 * turn; statements stream in and the surface materializes live.
 */

import { parseDocument } from '@openui/parser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderDocument, renderPartial } from './render';
import type { ServerMessage } from './transport';
import { runTurn } from './transport';
import type { RenderContext } from './types';

type Phase = 'idle' | 'thinking' | 'streaming' | 'ready';

const OPENING_PROMPT = 'Find Annapolis stays near City Dock and let me sort by distance';

export function App(): React.ReactNode {
  const [source, setSource] = useState('');
  const [vars, setVars] = useState<Record<string, unknown>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const turnBuffer = useRef<string[]>([]);
  const started = useRef(false);

  const runPrompt = useCallback(async (prompt: string) => {
    turnBuffer.current = [];
    setPhase('thinking');
    await runTurn(prompt, (msg: ServerMessage) => {
      if (msg.type === 'snapshot' && msg.source.length > 0) {
        setSource(msg.source);
        setVars(msg.vars);
      }
      if (msg.type === 'statement') {
        turnBuffer.current.push(msg.source);
        setSource(turnBuffer.current.join('\n'));
        setPhase('streaming');
      }
    });
    if (turnBuffer.current.length > 0) {
      setSource(turnBuffer.current.join('\n'));
    }
    setPhase('ready');
  }, []);

  // Kick off the opening turn once.
  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void runPrompt(OPENING_PROMPT);
  }, [
    runPrompt,
  ]);

  const doc = useMemo(
    () => parseDocument(source),
    [
      source,
    ],
  );

  // The document's own `$state` lines are the source of truth for reactive vars;
  // local edits (onSet) layer on top so inputs stay responsive between turns.
  const mergedVars = useMemo(() => {
    const fromDoc: Record<string, unknown> = {};
    for (const ref of doc.order) {
      const a = doc.assignments[ref];
      if (a?.kind === 'state' && a.expr.kind === 'literal') {
        fromDoc[a.ref.replace(/^\$/, '')] = a.expr.value;
      }
    }
    return {
      ...fromDoc,
      ...vars,
    };
  }, [
    doc,
    vars,
  ]);

  const ctx: RenderContext = useMemo(
    () => ({
      vars: mergedVars,
      onIntent: (message: string) => void runPrompt(message),
      onSet: (name: string, value: unknown) =>
        setVars((v) => ({
          ...v,
          [name]: value,
        })),
    }),
    [
      mergedVars,
      runPrompt,
    ],
  );

  const view = doc.root ? renderDocument(doc, ctx) : renderPartial(doc, ctx);
  const busy = phase === 'thinking' || phase === 'streaming';

  return (
    <div className="app">
      {busy && <ThinkingBar phase={phase} />}
      {view ?? <Booting />}
    </div>
  );
}

function ThinkingBar({ phase }: { phase: Phase }): React.ReactNode {
  return (
    <div className="thinking" role="status">
      <span className="thinking-dot" />
      {phase === 'thinking' ? 'Composing your stays…' : 'Rendering…'}
    </div>
  );
}

function Booting(): React.ReactNode {
  return (
    <div className="booting">
      <div className="booting-mark">Cais</div>
      <p>Waking the concierge…</p>
    </div>
  );
}
