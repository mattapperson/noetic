/**
 * Tests for TraceStorage
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStorage } from '../src/service/storage';
import type { ExecutionNode, ExecutionTrace } from '../src/shared/protocol';

function makeNode(index: number): ExecutionNode {
  return {
    id: `node-${index}`,
    stepId: `step-${index}`,
    kind: 'run',
    parentId: null,
    depth: 0,
    startTime: Date.now(),
    endTime: Date.now() + 100,
    durationMs: 100,
    status: 'completed',
    input: null,
    output: null,
    contextSnapshot: {
      depth: 0,
      stepCount: index + 1,
      tokens: {
        input: 10,
        output: 5,
        total: 15,
      },
      cost: 0.001,
      elapsedMs: 100,
      state: null,
      itemLogLength: 0,
    },
    stepData: {},
    children: [],
  };
}

function makeTrace(traceId: string, nodeCount = 0): ExecutionTrace {
  const nodes = new Map<string, ExecutionNode>();
  for (let i = 0; i < nodeCount; i++) {
    nodes.set(`node-${i}`, makeNode(i));
  }

  return {
    traceId,
    rootStepId: 'root',
    startTime: Date.now(),
    endTime: Date.now() + 1e3,
    status: 'completed',
    nodes,
    rootNodeId: nodeCount > 0 ? 'node-0' : '',
  };
}

describe('TraceStorage', () => {
  let tempDir: string;
  let storage: TraceStorage;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'noetic-storage-test-'));
    storage = new TraceStorage(tempDir);
    await storage.init();
  });

  afterEach(async () => {
    await rm(tempDir, {
      recursive: true,
      force: true,
    });
  });

  describe('saveTrace / loadRun round-trip', () => {
    it('saves and loads a trace successfully', async () => {
      const trace = makeTrace('run-001', 2);
      const result = await storage.saveTrace(trace, 'agent-a', 'hello');

      expect(result.success).toBe(true);
      expect(result.runId).toBe('run-001');
      expect(result.warning).toBeUndefined();

      const loaded = await storage.loadRun('agent-a', 'run-001');
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('run-001');
      expect(loaded!.agentId).toBe('agent-a');
      expect(loaded!.input).toBe('hello');
      expect(loaded!.status).toBe('completed');
    });

    it('preserves Map nodes through serialization', async () => {
      const trace = makeTrace('run-002', 3);
      await storage.saveTrace(trace, 'agent-a', null);

      const loaded = await storage.loadRun('agent-a', 'run-002');
      expect(loaded).not.toBeNull();
      expect(loaded!.trace).toBeDefined();
      // The trace.nodes should be deserialized back as a Map
      expect(loaded!.trace.nodes).toBeInstanceOf(Map);
      expect(loaded!.trace.nodes.size).toBe(3);
    });

    it('handles object input', async () => {
      const trace = makeTrace('run-003');
      const input = {
        prompt: 'test',
        temperature: 0.7,
      };
      await storage.saveTrace(trace, 'agent-b', input);

      const loaded = await storage.loadRun('agent-b', 'run-003');
      expect(loaded).not.toBeNull();
      expect(loaded!.input).toEqual({
        prompt: 'test',
        temperature: 0.7,
      });
    });
  });

  describe('loadRun for non-existent', () => {
    it('returns null for non-existent run', async () => {
      const result = await storage.loadRun('no-agent', 'no-run');
      expect(result).toBeNull();
    });

    it('returns null for non-existent agent', async () => {
      const result = await storage.loadRun('ghost-agent', 'ghost-run');
      expect(result).toBeNull();
    });
  });

  describe('listAgentRuns', () => {
    it('returns empty array for unknown agent', async () => {
      const runs = await storage.listAgentRuns('unknown-agent');
      expect(runs).toEqual([]);
    });

    it('returns runs sorted by startTime descending', async () => {
      // Create traces with different start times
      const trace1 = makeTrace('run-old');
      const trace2 = makeTrace('run-new');

      // Manually adjust start times
      trace1.startTime = 1000;
      trace2.startTime = 2000;

      await storage.saveTrace(trace1, 'agent-sorted', 'first');
      await storage.saveTrace(trace2, 'agent-sorted', 'second');

      const runs = await storage.listAgentRuns('agent-sorted');
      expect(runs).toHaveLength(2);
      // Newest first
      expect(runs[0].id).toBe('run-new');
      expect(runs[1].id).toBe('run-old');
    });

    it('lists multiple runs for an agent', async () => {
      await storage.saveTrace(makeTrace('r1'), 'agent-x', 'a');
      await storage.saveTrace(makeTrace('r2'), 'agent-x', 'b');
      await storage.saveTrace(makeTrace('r3'), 'agent-x', 'c');

      const runs = await storage.listAgentRuns('agent-x');
      expect(runs).toHaveLength(3);
    });
  });

  describe('deleteRun', () => {
    it('deletes an existing run and returns true', async () => {
      await storage.saveTrace(makeTrace('del-1'), 'agent-d', 'x');

      const deleted = await storage.deleteRun('agent-d', 'del-1');
      expect(deleted).toBe(true);

      const loaded = await storage.loadRun('agent-d', 'del-1');
      expect(loaded).toBeNull();
    });

    it('returns false for non-existent run', async () => {
      const deleted = await storage.deleteRun('agent-d', 'nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('inputPreview', () => {
    it('truncates long input previews', async () => {
      const longInput = 'a'.repeat(100);
      await storage.saveTrace(makeTrace('preview-1'), 'agent-p', longInput);

      const loaded = await storage.loadRun('agent-p', 'preview-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.inputPreview.length).toBeLessThanOrEqual(53); // 50 + "..."
    });

    it('keeps short input previews intact', async () => {
      await storage.saveTrace(makeTrace('preview-2'), 'agent-p', 'hi');

      const loaded = await storage.loadRun('agent-p', 'preview-2');
      expect(loaded).not.toBeNull();
      expect(loaded!.inputPreview).toBe('hi');
    });
  });

  describe('agent registration', () => {
    it('registers and lists agents', async () => {
      await storage.registerAgent('agent-reg', 'Test Agent');
      const agents = await storage.getRegisteredAgents();
      expect(agents).toContain('agent-reg');
    });

    it('unregisters agents', async () => {
      await storage.registerAgent('agent-unreg', 'Temp Agent');
      const existed = await storage.unregisterAgent('agent-unreg');
      expect(existed).toBe(true);

      const agents = await storage.getRegisteredAgents();
      expect(agents).not.toContain('agent-unreg');
    });

    it('unregister returns false for non-existent agent', async () => {
      const existed = await storage.unregisterAgent('nonexistent');
      expect(existed).toBe(false);
    });
  });
});
