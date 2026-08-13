/**
 * Manual end-to-end check for ACP agent steps.
 *
 * Exercises the REAL runtime — `AgentHarness.run()` and the JSON
 * hydrate-and-run path — against a REAL Agent Client Protocol connection. The
 * agent on the far end is an in-process `AgentSideConnection` reached through
 * the loopback transport, so every JSON-RPC frame, the `initialize` handshake,
 * `session/new`, `session/prompt`, `session/update` notifications, and the
 * client-side `fs/*` and permission callbacks all run for real. Only the
 * agent's *reasoning* is stubbed.
 *
 *   bun examples/acp-e2e.ts
 *
 * Set `ACP_LIVE_AGENT=1` to run the final path against a real spawned agent
 * (`npx @zed-industries/claude-code-acp`) instead — that path needs Claude Code
 * credentials and network access, so it is opt-in.
 */

import {
  claudeCode,
  createAcpAgentRegistry,
  defineAcpAgent,
  loopbackTransport,
} from '@noetic-tools/acp';
import type {
  AcpAgent,
  AcpSessionNotification,
  ContextData,
  ExecuteStepFn,
} from '@noetic-tools/core';
import {
  AgentHarness,
  createMessage,
  hydrateWorkflow,
  step,
  validateWorkflow,
} from '@noetic-tools/core';
import { frameworkCast } from '@noetic-tools/core/unstable';
import { z } from 'zod';

//#region Fake agent

interface FakeAgentOpts {
  /** Text the agent streams back as `agent_message_chunk` updates. */
  reply: string | ((prompt: string) => string);
  /** Announce a tool call mid-turn. */
  toolCall?: boolean;
  /** Ask the client for permission before the tool call. */
  requestPermission?: boolean;
  /** Read this path through the client's `fs/read_text_file`. */
  readPath?: string;
}

/** An ACP agent adapter whose far end is an in-process protocol server. */
function fakeAcpAgent(agentId: string, opts: FakeAgentOpts): AcpAgent {
  return defineAcpAgent({
    agentId,
    transport: loopbackTransport((conn) => {
      let sessions = 0;
      return {
        async initialize(params) {
          return {
            protocolVersion: params.protocolVersion,
            agentCapabilities: {
              promptCapabilities: {
                image: true,
              },
            },
            authMethods: [],
          };
        },
        async newSession() {
          sessions += 1;
          return {
            sessionId: `session-${sessions}`,
          };
        },
        async authenticate() {
          return {};
        },
        async prompt(params) {
          const promptText = params.prompt
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join('');

          if (opts.requestPermission) {
            const outcome = await conn.requestPermission({
              sessionId: params.sessionId,
              options: [
                {
                  optionId: 'yes',
                  name: 'Allow once',
                  kind: 'allow_once',
                },
                {
                  optionId: 'no',
                  name: 'Reject',
                  kind: 'reject_once',
                },
              ],
              toolCall: {
                toolCallId: 'call-1',
                title: 'Run rm -rf /tmp/scratch',
                kind: 'execute',
              },
            });
            const decision =
              outcome.outcome.outcome === 'selected' ? outcome.outcome.optionId : 'cancelled';
            await conn.sessionUpdate(chunk(params.sessionId, `permission:${decision}`));
            return {
              stopReason: 'end_turn',
            };
          }

          if (opts.readPath) {
            const file = await conn.readTextFile({
              sessionId: params.sessionId,
              path: opts.readPath,
            });
            await conn.sessionUpdate(chunk(params.sessionId, file.content));
            return {
              stopReason: 'end_turn',
            };
          }

          if (opts.toolCall) {
            await conn.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-1',
                title: 'Read repository',
                kind: 'read',
                status: 'completed',
                rawInput: {
                  path: '.',
                },
              },
            });
          }

          const reply = typeof opts.reply === 'function' ? opts.reply(promptText) : opts.reply;
          await conn.sessionUpdate(chunk(params.sessionId, reply));
          return {
            stopReason: 'end_turn',
          };
        },
        async cancel() {
          // Nothing long-running to interrupt.
        },
      };
    }),
  });
}

function chunk(sessionId: string, text: string): AcpSessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text,
      },
    },
  };
}

//#endregion

function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const harness = new AgentHarness({
    name: 'acp-e2e',
    params: {},
  });

  // ── Path A: programmatic, via AgentHarness.run() ──────────────────────────
  console.log('\n── Path A: programmatic (step.acpAgent + harness.run) ──');
  const codeStep = step.acpAgent({
    id: 'code-path',
    agent: fakeAcpAgent('claude-code', {
      reply: 'summary: 3 packages, all green',
      toolCall: true,
    }),
    prompt: 'Summarize the repository',
  });
  const ctxA = harness.createContext();
  const outA = await harness.run(codeStep, undefined, ctxA);
  console.log('  output:', JSON.stringify(outA));
  console.log('  itemLog items:', ctxA.itemLog.items.length);
  ok('returns the assistant text', outA === 'summary: 3 packages, all green');
  ok('appended user + assistant + tool-call items', ctxA.itemLog.items.length >= 3);
  ok('recorded lastStepMeta tool calls', (ctxA.lastStepMeta?.toolCalls?.length ?? 0) === 1);

  // ── Path B: JSON API, validate → hydrate(registry) → run ──────────────────
  console.log('\n── Path B: JSON API (validateWorkflow + hydrateWorkflow + harness.run) ──');
  const doc = {
    version: 1,
    root: {
      kind: 'acp-agent',
      id: 'json-path',
      agent: 'claude-code',
      prompt: 'List the open TODOs',
      mode: undefined,
    },
  };
  const validated = validateWorkflow(doc);
  ok('document validates against the workflow schema', validated.root.kind === 'acp-agent');

  const registry = createAcpAgentRegistry(
    fakeAcpAgent('claude-code', {
      reply: 'TODO: ship it',
    }),
  );
  // ExecuteStepFn is generic over the caller's TContext while harness.run pins
  // ContextData — bridged with frameworkCast, mirroring the internal idiom in
  // dynamic-workflow.ts and workflow-step.ts.
  const executeStep: ExecuteStepFn = frameworkCast(harness.run.bind(harness));
  const hydrated = hydrateWorkflow(validated, {
    tools: new Map(),
    executeStep,
    acpAgents: registry,
  });
  ok('node hydrates into an acp-agent step', hydrated.kind === 'acp-agent');

  const ctxB = harness.createContext();
  const outB = await harness.run(hydrated, '', ctxB);
  console.log('  output:', JSON.stringify(outB));
  ok('JSON workflow runs and returns the agent output', outB === 'TODO: ship it');

  // ── Path C: structured output through the step schema ─────────────────────
  console.log('\n── Path C: structured output (output schema) ──');
  const Schema = z.object({
    files: z.number(),
    clean: z.boolean(),
  });
  const structuredStep = step.acpAgent({
    id: 'structured',
    agent: fakeAcpAgent('codex', {
      reply: '{"files":3,"clean":true}',
    }),
    prompt: 'Inspect the workspace',
    output: Schema,
  });
  const ctxC = harness.createContext();
  const outC = await harness.run(structuredStep, undefined, ctxC);
  console.log('  output:', JSON.stringify(outC));
  ok('parses structured output via the step schema', outC.files === 3 && outC.clean === true);

  // ── Path D: agent output mapped onto the harness event surface ────────────
  console.log('\n── Path D: streaming via getFullStream() ──');
  const streamHarness = new AgentHarness({
    name: 'stream-demo',
    params: {},
    agentGraph: step.acpAgent({
      id: 'stream',
      agent: fakeAcpAgent('claude-code', {
        reply: 'streamed agent output',
      }),
      prompt: 'go',
    }),
  });
  await streamHarness.execute('go');
  let streamed = '';
  let sawCompleted = false;
  for await (const ev of streamHarness.getFullStream()) {
    if (
      ev.source === 'sdk' &&
      ev.type === 'response.output_text.delta' &&
      typeof ev.data.delta === 'string'
    ) {
      streamed += ev.data.delta;
    }
    if (ev.source === 'sdk' && ev.type === 'response.completed') {
      sawCompleted = true;
      break;
    }
  }
  console.log('  getFullStream() text:', JSON.stringify(streamed));
  ok(
    'agent output streams through the harness event surface',
    streamed === 'streamed agent output' && sawCompleted,
  );

  // ── Path E: the agent receives the prior conversation ─────────────────────
  console.log('\n── Path E: conversation history reaches the agent ──');
  const ctxE = harness.createContext();
  ctxE.itemLog.append(createMessage('Remember: we deploy to prod only on Fridays.', 'user'));
  ctxE.itemLog.append(createMessage('Understood.', 'developer'));
  const ctxStep = step.acpAgent<ContextData, unknown, string>({
    id: 'ctx',
    agent: fakeAcpAgent('claude-code', {
      // Answers strictly from what the prompt actually carried.
      reply: (prompt) =>
        prompt.includes('Fridays')
          ? 'We deploy to prod on Fridays.'
          : 'I have no record of our deploy schedule.',
    }),
    prompt: 'When do we deploy to prod?',
  });
  const outE = await harness.run(ctxStep, undefined, ctxE);
  console.log('  output:', JSON.stringify(outE));
  ok('agent answers from prior conversation', outE.includes('Fridays'));

  // ── Path F: the agent's file reads go through Noetic's FsAdapter ──────────
  console.log('\n── Path F: fs/read_text_file served by the Noetic FsAdapter ──');
  const ctxF = harness.createContext();
  await ctxF.fs.mkdir('/tmp/noetic-acp-e2e');
  await ctxF.fs.writeFile('/tmp/noetic-acp-e2e/note.txt', 'read through the adapter');
  const fsStep = step.acpAgent<ContextData, unknown, string>({
    id: 'fs',
    agent: fakeAcpAgent('claude-code', {
      reply: '',
      readPath: '/tmp/noetic-acp-e2e/note.txt',
    }),
    prompt: 'Read the note',
  });
  const outF = await harness.run(fsStep, undefined, ctxF);
  console.log('  output:', JSON.stringify(outF));
  ok('the agent read the file through ctx.fs', outF === 'read through the adapter');

  // ── Path G: permission policy answers session/request_permission ──────────
  console.log('\n── Path G: permission policy ──');
  const denyStep = step.acpAgent<ContextData, unknown, string>({
    id: 'deny',
    agent: fakeAcpAgent('claude-code', {
      reply: '',
      requestPermission: true,
    }),
    prompt: 'Clean the scratch dir',
    permissions: {
      default: 'deny',
    },
  });
  const outG1 = await harness.run(denyStep, undefined, harness.createContext());
  console.log('  deny-by-default output:', JSON.stringify(outG1));
  ok('an unmatched request is denied by default', outG1 === 'permission:no');

  const allowStep = step.acpAgent<ContextData, unknown, string>({
    id: 'allow',
    agent: fakeAcpAgent('claude-code', {
      reply: '',
      requestPermission: true,
    }),
    prompt: 'Clean the scratch dir',
    permissions: {
      allow: [
        {
          kind: 'execute',
        },
      ],
    },
  });
  const outG2 = await harness.run(allowStep, undefined, harness.createContext());
  console.log('  allow-rule output:', JSON.stringify(outG2));
  ok('a matching allow rule grants the tool call', outG2 === 'permission:yes');

  // ── Path H (opt-in): a real spawned ACP agent over stdio ──────────────────
  if (process.env.ACP_LIVE_AGENT === '1') {
    console.log('\n── Path H: LIVE agent over stdio (@zed-industries/claude-code-acp) ──');
    const liveStep = step.acpAgent<ContextData, unknown, string>({
      id: 'live',
      agent: claudeCode({
        // Claude Code refuses to launch nested inside another Claude Code
        // session. Spawning it as an ACP subprocess is exactly the supported
        // usage, so clear the marker the parent session sets.
        env: {
          CLAUDECODE: undefined,
        },
      }),
      prompt: 'Reply with exactly: ACP_OK',
      permissions: {
        default: 'deny',
      },
    });
    const outH = await harness.run(liveStep, undefined, harness.createContext());
    console.log('  output:', JSON.stringify(outH));
    ok('a real ACP agent completed a turn', outH.includes('ACP_OK'));
  } else {
    console.log('\n── Path H: skipped (set ACP_LIVE_AGENT=1 to run against a real agent) ──');
  }

  console.log(process.exitCode ? '\n❌ FAILED' : '\n✅ ALL PATHS PASSED');
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
