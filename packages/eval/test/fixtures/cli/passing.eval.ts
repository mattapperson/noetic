import { describe, it } from '../../../src';

// Offline fixture: the case never calls ctx.execute, so no LLM is involved.
describe({
  kind: 'run',
  id: 'fixture-pass',
}, {
  objective: 'cli exit-code fixture (all pass)',
}, () => {
  it('passes without scoring', async () => {});
});
