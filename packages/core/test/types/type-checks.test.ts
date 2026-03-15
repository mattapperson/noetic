import { describe, it, expect } from 'bun:test';
import type {
  Item, MessageItem, FunctionCallItem, FunctionCallOutputItem, ReasoningItem, ExtensionItem,
  Step, StepRun, StepLLM, StepTool, StepBranch, StepFork, StepSpawn, StepLoop,
  OrchidError, Context, ItemLog, Channel, ExternalChannel,
  MemoryLayer, MemoryScope, BudgetConfig,
  Snapshot, Verdict, Until, SettleResult,
  ContextInStrategy, ContextOutStrategy,
  RetryPolicy, ModelParams, Tool, TokenUsage, StepMeta, LLMResponse,
  Span, TraceExporter, MemoryTraceSpan,
  Runtime, AgentConfig,
  StorageAdapter, ScopedStorage, ProjectionPolicy,
  ExecutionContext, ExecutionOutcome,
} from '../../src/index';
import { Slot } from '../../src/index';

describe('Type definitions', () => {
  describe('Item discriminated union', () => {
    it('narrows MessageItem by type field', () => {
      const item: Item = {
        id: '1',
        status: 'completed',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      };
      if (item.type === 'message') {
        const msg = item as MessageItem;
        expect(msg.role).toBe('user');
        expect(msg.content[0]).toEqual({ type: 'input_text', text: 'hello' });
      }
    });

    it('narrows FunctionCallItem by type field', () => {
      const item: Item = {
        id: '2',
        status: 'completed',
        type: 'function_call',
        call_id: 'call_1',
        name: 'search',
        arguments: '{"q":"test"}',
      };
      if (item.type === 'function_call') {
        const fc = item as FunctionCallItem;
        expect(fc.name).toBe('search');
        expect(fc.call_id).toBe('call_1');
      }
    });

    it('narrows FunctionCallOutputItem by type field', () => {
      const item: Item = {
        id: '3',
        status: 'completed',
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"results":[]}',
      };
      if (item.type === 'function_call_output') {
        const fco = item as FunctionCallOutputItem;
        expect(fco.output).toBe('{"results":[]}');
      }
    });

    it('narrows ReasoningItem by type field', () => {
      const item: Item = {
        id: '4',
        status: 'completed',
        type: 'reasoning',
        content: [{ type: 'output_text', text: 'thinking...' }],
      };
      if (item.type === 'reasoning') {
        const r = item as ReasoningItem;
        expect(r.content).toHaveLength(1);
      }
    });

    it('supports all content part types', () => {
      const msg: MessageItem = {
        id: '5',
        status: 'completed',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'response' },
          { type: 'input_text', text: 'input' },
          { type: 'refusal', refusal: 'I cannot do that' },
        ],
      };
      expect(msg.content).toHaveLength(3);
    });
  });

  describe('Step discriminated union', () => {
    it('narrows StepRun by kind', () => {
      const s: Step<string, number> = {
        kind: 'run',
        id: 'test',
        execute: async (input: string) => input.length,
      };
      if (s.kind === 'run') {
        expect(s.id).toBe('test');
        expect(s.execute).toBeFunction();
      }
    });

    it('narrows StepLLM by kind', () => {
      const s: Step<string, string> = {
        kind: 'llm',
        id: 'llm-test',
        model: 'gpt-4',
      };
      if (s.kind === 'llm') {
        expect(s.model).toBe('gpt-4');
      }
    });

    it('narrows StepLoop by kind', () => {
      const s: Step<string, string> = {
        kind: 'loop',
        id: 'loop-test',
        body: { kind: 'run', id: 'body', execute: async (i: string) => i },
        until: (snap: Snapshot) => ({ stop: snap.stepCount >= 3 }),
      };
      if (s.kind === 'loop') {
        expect(s.body.kind).toBe('run');
      }
    });

    it('narrows StepFork by kind and mode', () => {
      const s: Step<string, string> = {
        kind: 'fork',
        id: 'fork-test',
        mode: 'all',
        paths: () => [],
        merge: (results: string[]) => results.join(','),
      };
      if (s.kind === 'fork' && s.mode === 'all') {
        expect(s.merge).toBeFunction();
      }
    });

    it('narrows StepSpawn by kind', () => {
      const s: Step<string, string> = {
        kind: 'spawn',
        id: 'spawn-test',
        child: { kind: 'run', id: 'child', execute: async (i: string) => i },
        contextIn: { strategy: 'fresh' },
        contextOut: { strategy: 'full' },
      };
      if (s.kind === 'spawn') {
        expect(s.contextIn.strategy).toBe('fresh');
        expect(s.contextOut.strategy).toBe('full');
      }
    });

    it('narrows StepBranch by kind', () => {
      const s: Step<string, string> = {
        kind: 'branch',
        id: 'branch-test',
        route: () => null,
      };
      if (s.kind === 'branch') {
        expect(s.route).toBeFunction();
      }
    });
  });

  describe('OrchidError discriminated union', () => {
    it('narrows by kind', () => {
      const err: OrchidError = {
        kind: 'step_failed',
        stepId: 'test',
        cause: new Error('boom'),
        retriesExhausted: true,
      };
      if (err.kind === 'step_failed') {
        expect(err.retriesExhausted).toBe(true);
        expect(err.cause.message).toBe('boom');
      }
    });

    it('supports all error kinds', () => {
      const kinds: OrchidError['kind'][] = [
        'step_failed', 'llm_refused', 'llm_parse_error', 'llm_rate_limit',
        'fork_partial', 'spawn_summary_failed', 'channel_timeout',
        'channel_closed', 'cancelled', 'budget_exceeded',
      ];
      expect(kinds).toHaveLength(10);
    });
  });

  describe('ContextInStrategy', () => {
    it('supports all four strategies', () => {
      const strategies: ContextInStrategy[] = [
        { strategy: 'inherit' },
        { strategy: 'fresh' },
        { strategy: 'subset', select: (items) => items },
        { strategy: 'custom', build: () => [] },
      ];
      expect(strategies).toHaveLength(4);
    });
  });

  describe('ContextOutStrategy', () => {
    it('supports all three strategies', () => {
      const strategies: ContextOutStrategy<string>[] = [
        { strategy: 'full' },
        { strategy: 'summary', model: 'gpt-4' },
        { strategy: 'schema', schema: {} as any },
      ];
      expect(strategies).toHaveLength(3);
    });
  });

  describe('Memory types', () => {
    it('Slot constants have correct values', () => {
      expect(Slot.WORKING_MEMORY).toBe(100);
      expect(Slot.ENTITY).toBe(150);
      expect(Slot.OBSERVATIONS).toBe(200);
      expect(Slot.PROCEDURAL).toBe(250);
      expect(Slot.EPISODIC).toBe(300);
      expect(Slot.RAG).toBe(350);
      expect(Slot.SEMANTIC_RECALL).toBe(400);
    });

    it('supports all memory scopes', () => {
      const scopes: MemoryScope[] = ['thread', 'resource', 'global', 'execution'];
      expect(scopes).toHaveLength(4);
    });

    it('BudgetConfig supports all forms', () => {
      const configs: BudgetConfig[] = [
        1000,
        { min: 200, max: 1500 },
        'auto',
      ];
      expect(configs).toHaveLength(3);
    });
  });

  describe('SettleResult', () => {
    it('has fulfilled and rejected variants', () => {
      const fulfilled: SettleResult<string> = {
        stepId: 's1',
        status: 'fulfilled',
        value: 'result',
      };
      const rejected: SettleResult<string> = {
        stepId: 's2',
        status: 'rejected',
        error: { kind: 'cancelled', reason: 'test' },
      };
      expect(fulfilled.status).toBe('fulfilled');
      expect(rejected.status).toBe('rejected');
    });
  });
});
