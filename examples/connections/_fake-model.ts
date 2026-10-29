/**
 * A scripted OpenRouter Responses API on a local port. The harness drives its
 * real model client against it: tool exposure, tool execution and gates.
 * `reply(input, tools, round)` answers each round; `rounds` holds each request.
 */

import { z } from 'zod';

//#region Types

export interface FakeModelRound {
  readonly input: unknown[];
  readonly toolNames: string[];
  readonly raw: string;
}

export interface FakeModel {
  readonly baseUrl: string;
  readonly rounds: FakeModelRound[];
  stop(): void;
}

export type FakeReply = (input: unknown[], toolNames: string[], round: number) => unknown[];

//#endregion

//#region Output items

export function functionCall(name: string, args: unknown, n: number): Record<string, unknown> {
  return {
    type: 'function_call',
    id: `fc_${n}`,
    call_id: `call_${n}`,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}

export function message(text: string): Record<string, unknown> {
  return {
    type: 'message',
    id: `msg_${crypto.randomUUID()}`,
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  };
}

/** The `function_call_output` entries the model has been sent so far. */
export function toolOutputs(input: unknown[]): Array<{
  callId: string;
  output: string;
}> {
  const Schema = z.object({
    type: z.literal('function_call_output'),
    call_id: z.string(),
    output: z.unknown(),
  });
  return input.flatMap((entry) => {
    const parsed = Schema.safeParse(entry);
    if (!parsed.success) {
      return [];
    }
    const output = parsed.data.output;
    return [
      {
        callId: parsed.data.call_id,
        output: typeof output === 'string' ? output : JSON.stringify(output),
      },
    ];
  });
}

//#endregion

//#region Server

const BodySchema = z.object({
  model: z.string(),
  input: z.array(z.unknown()).default([]),
  tools: z
    .array(
      z.looseObject({
        name: z.string().optional(),
      }),
    )
    .optional(),
});

function responseStream(round: number, model: string, output: unknown[]): string {
  const now = Math.floor(Date.now() / 1e3);
  const response = {
    id: `resp_${round}`,
    object: 'response',
    created_at: now,
    completed_at: now,
    model,
    status: 'completed',
    error: null,
    frequency_penalty: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    presence_penalty: null,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    output,
    usage: {
      input_tokens: 10,
      input_tokens_details: {
        cached_tokens: 0,
      },
      output_tokens: 5,
      output_tokens_details: {
        reasoning_tokens: 0,
      },
      total_tokens: 15,
      cost: 0,
    },
  };
  const events = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: {
        ...response,
        status: 'in_progress',
        output: [],
      },
    },
    {
      type: 'response.completed',
      sequence_number: 1,
      response,
    },
  ];
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
}

export function startFakeModel(reply: FakeReply): FakeModel {
  const rounds: FakeModelRound[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') {
        return new Response('{}', {
          status: 404,
        });
      }
      const raw = await request.text();
      const body = BodySchema.parse(JSON.parse(raw));
      const toolNames = (body.tools ?? []).flatMap((t) =>
        t.name === undefined
          ? []
          : [
              t.name,
            ],
      );
      rounds.push({
        input: body.input,
        toolNames,
        raw,
      });
      const round = rounds.length;
      return new Response(responseStream(round, body.model, reply(body.input, toolNames, round)), {
        headers: {
          'content-type': 'text/event-stream',
          'x-generation-id': `gen-${round}`,
        },
      });
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}/api/v1`,
    rounds,
    stop: () => server.stop(true),
  };
}

//#endregion
