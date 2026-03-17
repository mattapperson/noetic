import { describe, expect, it } from 'bun:test';
import { buildParallelResearchAgent } from '../../examples/parallel-research';
import { InMemoryRuntime } from '../../src/runtime/in-memory-runtime';
import { createScriptedCallModel, textOnlyResponse } from '../_helpers';

describe('parallel research agent', () => {
  it('buildParallelResearchAgent creates a fork in all mode', () => {
    const agent = buildParallelResearchAgent();

    expect(agent.kind).toBe('fork');
    expect(agent.id).toBe('parallel-research');
    expect(agent.mode).toBe('all');
  });

  it('forks into three spawn paths', () => {
    const agent = buildParallelResearchAgent();
    const paths = agent.paths('any-input');

    expect(paths).toHaveLength(3);
    for (const path of paths) {
      expect(path.kind).toBe('spawn');
    }
  });

  it('merges three perspective results into a structured summary', async () => {
    const callModel = createScriptedCallModel([
      textOnlyResponse('Historical perspective on the topic.'),
      textOnlyResponse('Technical perspective on the topic.'),
      textOnlyResponse('Societal perspective on the topic.'),
    ]);
    const runtime = new InMemoryRuntime({
      callModel,
    });
    const ctx = runtime.createContext();
    const agent = buildParallelResearchAgent();

    const result = await runtime.execute(agent, 'artificial intelligence', ctx);

    expect(result).toContain('# Research Summary');
    expect(result).toContain('## Historical Context');
    expect(result).toContain('## Technical Analysis');
    expect(result).toContain('## Societal Impact');
    expect(result).toContain('Historical perspective on the topic.');
    expect(result).toContain('Technical perspective on the topic.');
    expect(result).toContain('Societal perspective on the topic.');
  });
});
