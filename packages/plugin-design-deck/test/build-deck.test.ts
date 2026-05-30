import { describe, expect, test } from 'bun:test';

import type { CallModel, CallModelInput, CallModelResponse } from '@noetic-tools/cli';

import { buildDeck } from '../src/generate/build-deck.js';

function mockCallModel(text: string, record: CallModelInput[] = []): CallModel {
  return async (input) => {
    record.push(input);
    const response: CallModelResponse = {
      text,
      modelId: input.model ?? 'mock',
    };
    return response;
  };
}

describe('buildDeck', () => {
  test('parses a valid deck JSON response', async () => {
    const deck = await buildDeck({
      callModel: mockCallModel(
        JSON.stringify({
          title: 'Pick an ORM',
          slides: [
            {
              id: 'orm',
              title: 'Pick an ORM',
              context: 'For Postgres.',
              options: [
                {
                  label: 'Drizzle',
                  description: 'typesafe',
                },
                {
                  label: 'Prisma',
                  description: 'popular',
                },
              ],
            },
          ],
        }),
      ),
      topic: 'Pick an ORM for Postgres',
    });
    expect(deck.title).toBe('Pick an ORM');
    expect(deck.slides[0]?.options).toHaveLength(2);
  });

  test('throws on invalid JSON', async () => {
    await expect(
      buildDeck({
        callModel: mockCallModel('not json'),
        topic: 'x',
      }),
    ).rejects.toThrow(/schema check/);
  });

  test('passes topic into the user message', async () => {
    const record: CallModelInput[] = [];
    await expect(
      buildDeck({
        callModel: mockCallModel(
          JSON.stringify({
            title: 'T',
            slides: [
              {
                id: 'a',
                title: 't',
                options: [
                  {
                    label: 'x',
                  },
                ],
              },
            ],
          }),
          record,
        ),
        topic: 'MY UNIQUE TOPIC',
      }),
    ).resolves.toBeTruthy();
    const userMsg = record[0]?.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('MY UNIQUE TOPIC');
  });
});
