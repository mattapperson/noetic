/**
 * Wrapper that generates a deck from a topic (via buildDeck) and then hands
 * off to DeckModal. Shows a spinner line while the first generation is in
 * flight so the modal isn't a blank frame.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { buildDeck } from '../generate/build-deck.js';
import type { Deck } from '../types.js';
import type { DeckModalProps } from './deck-modal.js';
import { DeckModal } from './deck-modal.js';

type State =
  | {
      kind: 'loading';
      topic: string;
    }
  | {
      kind: 'error';
      message: string;
    }
  | {
      kind: 'deck';
      deck: Deck;
    };

interface LoaderModalProps extends Omit<DeckModalProps, 'deck'> {
  topic: string;
  model?: string;
}

export function LoaderModal(props: LoaderModalProps): ReactNode {
  const [state, setState] = useState<State>({
    kind: 'loading',
    topic: props.topic,
  });

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const deck = await buildDeck({
          callModel: props.callModel,
          topic: props.topic,
          model: props.model ?? props.generateModel,
        });
        if (cancelled) {
          return;
        }
        setState({
          kind: 'deck',
          deck,
        });
      } catch (err) {
        if (cancelled) {
          return;
        }
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    props.callModel,
    props.topic,
    props.model,
    props.generateModel,
  ]);

  useInput((_input, key) => {
    if (state.kind === 'error' && key.escape) {
      props.onDone('Deck generation cancelled.');
    }
  });

  if (state.kind === 'loading') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Design deck</Text>
        <Box marginTop={1}>
          <Text dimColor>Generating a deck for: {state.topic}…</Text>
        </Box>
      </Box>
    );
  }

  if (state.kind === 'error') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="red">
          Deck generation failed
        </Text>
        <Box marginTop={1}>
          <Text>{state.message}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Esc to cancel.</Text>
        </Box>
      </Box>
    );
  }

  return <DeckModal {...props} deck={state.deck} />;
}
