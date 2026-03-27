import { describe, expect, it } from 'bun:test';
import { buildDynamicDelegateAgent, delegateInbox } from '../../examples/dynamic-delegate';
import { InMemoryRuntime } from '../../src/runtime/in-memory-runtime';
import { createScriptedCallModel, textOnlyResponse, toolCallResponse } from '../_helpers';

describe('dynamic delegate demo', () => {
  it('builds agent with both sync and async tools', () => {
    const agent = buildDynamicDelegateAgent({
      inbox: delegateInbox,
    });

    expect(agent.kind).toBe('loop');
    expect(agent.id).toBe('dynamic-delegate-loop');
    expect(agent.inbox).toBe(delegateInbox);
    expect(agent.parkTimeout).toBe(5e3);
    expect(agent.steps[0].kind).toBe('llm');
  });

  it('LLM uses sync delegate tool and gets result immediately', async () => {
    const callModel = createScriptedCallModel([
      // Step 1: LLM calls delegate (sync) tool
      toolCallResponse({
        toolName: 'delegate',
        args: '{"task":"What is 2+2?"}',
        output: '"4"',
        finalText: 'I delegated the math question.',
      }),
      // Step 2: LLM gives final answer (no tool calls → stops)
      textOnlyResponse('The answer is 4.'),
    ]);

    const runtime = new InMemoryRuntime({
      callModel,
    });

    const agent = buildDynamicDelegateAgent({
      inbox: delegateInbox,
      parkTimeout: 50,
    });

    const ctx = runtime.createContext();
    const result = await runtime.execute(agent, 'What is 2+2?', ctx);
    expect(result).toBe('The answer is 4.');
  });

  it('LLM uses async launch tool and receives result via inbox', async () => {
    const callModel = createScriptedCallModel([
      // Step 1: LLM calls launch_agent (async) tool
      toolCallResponse({
        toolName: 'launch_agent',
        args: '{"task":"research topic"}',
        output: '{"agentId":"bg-1"}',
        finalText: 'Launched background research.',
      }),
      // Step 2: no tool calls → until says stop → inbox has message → continue
      textOnlyResponse('Waiting for background work.'),
      // Step 3: no tool calls → until says stop → inbox empty → truly stop
      textOnlyResponse('Got the results from the background agent.'),
    ]);

    const runtime = new InMemoryRuntime({
      callModel,
    });
    const ctx = runtime.createContext();

    // Pre-load inbox message to simulate sub-agent completion
    runtime.send(delegateInbox, '[Sub-agent bg-1 completed] Topic is interesting.', ctx);

    const agent = buildDynamicDelegateAgent({
      inbox: delegateInbox,
      parkTimeout: 50,
    });

    const result = await runtime.execute(agent, 'Research a topic for me', ctx);
    expect(result).toBe('Got the results from the background agent.');
  });

  it('LLM can mix sync and async in the same conversation', async () => {
    const callModel = createScriptedCallModel([
      // Step 1: LLM uses async launch for background research
      toolCallResponse({
        toolName: 'launch_agent',
        args: '{"task":"background research"}',
        output: '{"agentId":"bg-2"}',
        finalText: 'Started background research.',
      }),
      // Step 2: LLM uses sync delegate for immediate answer
      toolCallResponse({
        toolName: 'delegate',
        args: '{"task":"quick question"}',
        output: '"quick answer"',
        finalText: 'Got the quick answer.',
      }),
      // Step 3: no tool calls → until says stop → inbox has bg result → continue
      textOnlyResponse('Now incorporating background results.'),
      // Step 4: no tool calls → until says stop → inbox empty → truly stop
      textOnlyResponse('All done with both sync and async results.'),
    ]);

    const runtime = new InMemoryRuntime({
      callModel,
    });
    const ctx = runtime.createContext();

    // Pre-load inbox message for the async agent
    runtime.send(delegateInbox, '[Sub-agent bg-2 completed] Background findings.', ctx);

    const agent = buildDynamicDelegateAgent({
      inbox: delegateInbox,
      parkTimeout: 50,
    });

    const result = await runtime.execute(agent, 'Do both sync and async work', ctx);
    expect(result).toBe('All done with both sync and async results.');
  });
});
