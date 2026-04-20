import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { DiscoverTurn } from '../generate/discover.js';
import { nextDiscoverTurn } from '../generate/discover.js';
import type { Deck } from '../types.js';
import type { DeckModalProps } from './deck-modal.js';
import { DeckModal } from './deck-modal.js';

type Mode =
  | {
      kind: 'loading';
    }
  | {
      kind: 'question';
      question: string;
    }
  | {
      kind: 'error';
      message: string;
    }
  | {
      kind: 'deck';
      deck: Deck;
    };

type DiscoverModalProps = Omit<DeckModalProps, 'deck'>;

export function DiscoverModal(props: DiscoverModalProps): ReactNode {
  const [mode, setMode] = useState<Mode>({
    kind: 'loading',
  });
  const [history, setHistory] = useState<ReadonlyArray<DiscoverTurn>>([]);
  const [answer, setAnswer] = useState('');

  const advance = useCallback(
    async (historyAfter: ReadonlyArray<DiscoverTurn>): Promise<void> => {
      setMode({
        kind: 'loading',
      });
      try {
        const result = await nextDiscoverTurn({
          callModel: props.callModel,
          history: historyAfter,
          model: props.generateModel,
        });
        if (result.kind === 'deck') {
          setMode({
            kind: 'deck',
            deck: result.deck,
          });
        } else {
          setMode({
            kind: 'question',
            question: result.question,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMode({
          kind: 'error',
          message,
        });
      }
    },
    [
      props.callModel,
      props.generateModel,
    ],
  );

  useEffect(() => {
    void advance([]);
  }, [
    advance,
  ]);

  useInput((_input, key) => {
    if (mode.kind === 'error' && key.escape) {
      props.onDone('Discover cancelled.');
    }
  });

  if (mode.kind === 'deck') {
    return <DeckModal {...props} deck={mode.deck} />;
  }

  if (mode.kind === 'loading') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Deck discovery</Text>
        <Box marginTop={1}>
          <Text dimColor>Thinking…</Text>
        </Box>
      </Box>
    );
  }

  if (mode.kind === 'error') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="red">
          Discover failed
        </Text>
        <Box marginTop={1}>
          <Text>{mode.message}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Esc to cancel.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Deck discovery</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan">{mode.question}</Text>
        <Box marginTop={1}>
          <Text>{'> '}</Text>
          <TextInput
            value={answer}
            onChange={setAnswer}
            onSubmit={(value) => {
              const trimmed = value.trim();
              if (trimmed.length === 0) {
                return;
              }
              const turn: DiscoverTurn = {
                question: mode.question,
                answer: trimmed,
              };
              const next = [
                ...history,
                turn,
              ];
              setHistory(next);
              setAnswer('');
              void advance(next);
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Type DONE to generate the deck now.</Text>
        </Box>
      </Box>
    </Box>
  );
}
