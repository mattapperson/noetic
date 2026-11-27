/**
 * One JSON workflow document a host could compile from its own flow format, run
 * end to end on one harness (spec 26): a schema-output `callModel` on the
 * harness model, an `invokeTool` with computed args, a `decide`, a fork whose
 * results are keyed by branch, a loop whose run count a later node reads, and
 * an `acp-agent` node prompted with its input, against an in-process agent over
 * the real JSON-RPC wire.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { AgentHarness, execute, hydrateWorkflow } from '@noetic-tools/core';
import type {
  AgentScope,
  CallModelRequest,
  DecideRequest,
  Tool,
  WorkflowDocument,
} from '@noetic-tools/types';
import { validateWorkflow } from '@noetic-tools/types';
import { z } from 'zod';
import { claudeCode } from '../src/agents';
import { createAcpAgentRegistry } from '../src/registry';
import { scripted, scriptedSubprocess } from './_helpers';

//#region Fixtures

const DOCUMENT: WorkflowDocument = {
  version: 1,
  root: {
    kind: 'sequence',
    id: 'main',
    steps: [
      {
        kind: 'callModel',
        id: 'triage',
        instructions: 'Read the ticket.',
        output: {
          schema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
              },
              urgent: {
                type: 'boolean',
              },
            },
            required: [
              'title',
              'urgent',
            ],
            additionalProperties: false,
          },
        },
      },
      {
        kind: 'invokeTool',
        id: 'file',
        toolName: 'file-ticket',
        args: {
          title: {
            $expr: 'title',
          },
          urgent: {
            $expr: '$steps.triage.urgent',
          },
          source: 'chat',
        },
      },
      {
        kind: 'decide',
        id: 'route',
        questions: {
          team: {
            type: 'choice',
            instructions: 'Which team owns it?',
            choices: {
              billing: 'Refunds',
              auth: 'Sign-in',
            },
          },
        },
      },
      {
        kind: 'inParallel',
        id: 'fan',
        mode: 'all',
        paths: [
          {
            kind: 'compute',
            id: 'owner',
            expr: 'team.value',
          },
          {
            kind: 'compute',
            id: 'ticket',
            expr: '$steps.file.id',
          },
        ],
      },
      {
        kind: 'compute',
        id: 'keyed',
        expr: '{ "owner": $steps.owner, "ticket": $steps.ticket, "n": 0 }',
      },
      {
        kind: 'loop',
        id: 'tries',
        body: {
          kind: 'compute',
          id: 'try',
          expr: '$merge([$, { "n": n + 1 }])',
        },
        until: {
          kind: 'expr',
          expr: 'n = 3',
        },
      },
      {
        kind: 'compute',
        id: 'brief',
        expr: "'Fix ' & $steps.triage.title & ' (' & ticket & ') for ' & owner & ' after ' & $runs.tries & ' tries'",
      },
      {
        kind: 'acp-agent',
        id: 'fix',
        agent: 'claude-code',
        emit: false,
      },
    ],
  },
};

interface Seen {
  model: CallModelRequest[];
  decide: DecideRequest[];
  filed: unknown[];
  prompts: string[];
  sessions: acp.NewSessionRequest[];
  events: Array<{
    type: string;
    data: Record<string, unknown>;
    scope?: AgentScope;
  }>;
}

function emptySeen(): Seen {
  return {
    model: [],
    decide: [],
    filed: [],
    prompts: [],
    sessions: [],
    events: [],
  };
}

/** An agent that notes each prompt's text and answers `fixed: <text>`. */
function agentFor(seen: Seen) {
  return (conn: AgentSideConnection): acp.Agent => ({
    async initialize(params) {
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: {},
      };
    },
    async newSession(params) {
      seen.sessions.push(params);
      return {
        sessionId: 'primary',
      };
    },
    async authenticate() {
      return {};
    },
    async prompt(params) {
      const text = params.prompt.flatMap((block) =>
        block.type === 'text'
          ? [
              block.text,
            ]
          : [],
      );
      seen.prompts.push(text.join(''));
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `fixed: ${text.join('')}`,
          },
        },
      });
      return {
        stopReason: 'end_turn',
      };
    },
    async cancel() {
      return;
    },
  });
}

function fileTicket(seen: Seen): Tool {
  return {
    name: 'file-ticket',
    description: 'Files a ticket.',
    input: z.record(z.string(), z.unknown()),
    output: z.object({
      id: z.string(),
    }),
    execute: async (args: unknown) => {
      seen.filed.push(args);
      return {
        id: 'T-1',
      };
    },
  };
}

function harnessFor(seen: Seen): AgentHarness {
  return new AgentHarness({
    name: 'workflow-document',
    environment: {
      subprocess: scriptedSubprocess,
    },
    params: {},
    model: 'host/default',
    decisionModel: 'host/decider',
    _testCallModel: async (request) => {
      seen.model.push(request);
      return {
        items: [
          {
            id: 'answer',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: '{"title":"Login fails","urgent":true}',
              },
            ],
          },
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
      };
    },
    _testDecide: async (request) => {
      seen.decide.push(request);
      return {
        answers: {
          team: {
            type: 'choice',
            value: 'auth',
            confidence: 0.9,
            probabilities: {
              billing: 0.1,
              auth: 0.9,
            },
          },
        },
        source: 'native',
        modelId: request.model,
        usage: {
          inputTokens: 1,
          outputTokens: 0,
        },
      };
    },
  });
}

//#endregion

describe('an acp-agent node reading the harness params', () => {
  it('asks the prompt function on every run, and filters events with the emit function', async () => {
    const seen = emptySeen();
    let turn = 0;
    const filtered: string[] = [];
    const harness = new AgentHarness({
      name: 'workflow-document',
      environment: {
        subprocess: scriptedSubprocess,
      },
      params: {
        nextPrompt: () => `task ${++turn}`,
        rules: 'Never push to main.',
        quiet: (eventType: string) => {
          filtered.push(eventType);
          return false;
        },
      },
    });
    const root = hydrateWorkflow(
      validateWorkflow({
        version: 1,
        root: {
          kind: 'acp-agent',
          id: 'fix',
          agent: 'claude-code',
          fromParams: {
            prompt: 'nextPrompt',
            instructions: 'rules',
            emit: 'quiet',
          },
        },
      }),
      {
        tools: new Map(),
        executeStep: execute,
        acpAgents: createAcpAgentRegistry(
          claudeCode({
            command: scripted(agentFor(seen)),
          }),
        ),
      },
    );
    for (const _ of [
      1,
      2,
    ]) {
      const ctx = harness.createContext();
      Reflect.set(ctx, '_broadcaster', {
        emit(event: Seen['events'][number]) {
          seen.events.push(event);
        },
      });
      await harness.run(root, 'ignored input', ctx);
    }
    expect(seen.prompts).toEqual([
      'task 1',
      'task 2',
    ]);
    expect(filtered.length).toBeGreaterThan(0);
    expect(seen.events.filter((event) => event.data.stepId === 'fix')).toEqual([]);
  });
});

describe('an acp-agent node reading where and what to send from the params', () => {
  it('opens the session in the cwd, with the instructions and content, the functions give', async () => {
    const seen = emptySeen();
    const harness = new AgentHarness({
      name: 'workflow-document',
      environment: {
        subprocess: scriptedSubprocess,
      },
      params: {
        where: () => '/work/site',
        rules: () => 'Never push to main.',
        blocks: () => [
          {
            type: 'text',
            text: ' Also read NOTES.md.',
          },
        ],
      },
    });
    const root = hydrateWorkflow(
      validateWorkflow({
        version: 1,
        root: {
          kind: 'acp-agent',
          id: 'fix',
          agent: 'claude-code',
          prompt: 'Fix the build.',
          fromParams: {
            cwd: 'where',
            instructions: 'rules',
            content: 'blocks',
          },
        },
      }),
      {
        tools: new Map(),
        executeStep: execute,
        acpAgents: createAcpAgentRegistry(
          claudeCode({
            command: scripted(agentFor(seen)),
          }),
        ),
      },
    );
    await harness.run(root, '', harness.createContext());
    expect(seen.sessions[0]?.cwd).toBe('/work/site');
    expect(JSON.stringify(seen.sessions[0]?._meta)).toContain('Never push to main.');
    expect(seen.prompts).toEqual([
      'Fix the build. Also read NOTES.md.',
    ]);
  });
});

describe('a host-compiled workflow document', () => {
  it('runs every node on one harness', async () => {
    const seen = emptySeen();
    const harness = harnessFor(seen);
    const tool = fileTicket(seen);
    const root = hydrateWorkflow(validateWorkflow(DOCUMENT), {
      tools: new Map([
        [
          tool.name,
          tool,
        ],
      ]),
      executeStep: execute,
      acpAgents: createAcpAgentRegistry(
        claudeCode({
          command: scripted(agentFor(seen)),
        }),
      ),
    });
    const ctx = harness.createContext();
    Reflect.set(ctx, '_broadcaster', {
      emit(event: Seen['events'][number]) {
        seen.events.push(event);
      },
    });

    const output = await harness.run(root, 'Customers cannot sign in.', ctx);

    const brief = 'Fix Login fails (T-1) for auth after 3 tries';
    // The agent was prompted with the node's input, after the conversation so far.
    expect(seen.prompts).toHaveLength(1);
    expect(seen.prompts[0]).toEndWith(`Current request:\n${brief}`);
    expect(output).toBe(`fixed: ${seen.prompts[0]}`);
    // The schema-output call ran on the harness model.
    expect(seen.model).toHaveLength(1);
    expect(seen.model[0]?.model).toBe('host/default');
    assert(seen.model[0]?.outputSchema);
    // The tool got its computed args.
    expect(seen.filed).toEqual([
      {
        title: 'Login fails',
        urgent: true,
        source: 'chat',
      },
    ]);
    expect(seen.decide).toHaveLength(1);
    // `emit: false` kept the agent's turn out of the stream; other nodes still report.
    const stepsSeen = new Set(seen.events.map((event) => event.data.stepId));
    expect(stepsSeen.has('triage')).toBe(true);
    expect(stepsSeen.has('fix')).toBe(false);
    expect(seen.events.some((event) => event.type.includes('acp'))).toBe(false);
  });
});
