/**
 * App orchestration. Owns no UI *design* state — it accumulates the raw OpenUI
 * Lang source the agent streams and hands it to react-lang's <Renderer>, which
 * parses, evaluates reactive `$state`, and projects it through the Airbnb
 * library. A prompt (or a card interaction routed through `onAction`) starts a
 * turn; statements stream in and the surface materializes live.
 */

import type { ActionEvent } from '@openuidev/react-lang';
import { BuiltinActionType, Renderer } from '@openuidev/react-lang';
import { useCallback, useEffect, useRef, useState } from 'react';
import { airbnbLibrary } from './components';
import type { ServerMessage } from './transport';
import { runTurn } from './transport';

type Phase = 'idle' | 'thinking' | 'streaming' | 'ready';

const OPENING_PROMPT = 'Find Annapolis stays near City Dock and let me sort by distance';

export function App(): React.ReactNode {
  const [source, setSource] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const turnBuffer = useRef<string[]>([]);
  const started = useRef(false);

  const runPrompt = useCallback(async (prompt: string) => {
    turnBuffer.current = [];
    setPhase('thinking');
    await runTurn(prompt, (msg: ServerMessage) => {
      if (msg.type === 'snapshot' && msg.source.length > 0) {
        setSource(msg.source);
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

  // Card/chip/button interactions surface here as ActionEvents. `@Set` and
  // `@Run` steps are applied inside the Renderer (reactive store); a
  // ContinueConversation (`@ToAssistant`) is what drives the next agent turn.
  const handleAction = useCallback(
    (event: ActionEvent) => {
      if (event.type === BuiltinActionType.ContinueConversation && event.humanFriendlyMessage) {
        void runPrompt(event.humanFriendlyMessage);
      }
    },
    [
      runPrompt,
    ],
  );

  const busy = phase === 'thinking' || phase === 'streaming';

  return (
    <div className="app">
      {busy && <ThinkingBar phase={phase} />}
      {source.length > 0 ? (
        <Renderer
          response={source}
          library={airbnbLibrary}
          isStreaming={busy}
          onAction={handleAction}
        />
      ) : (
        <Booting />
      )}
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
