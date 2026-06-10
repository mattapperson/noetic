import { describe, it } from '../../../src';

// Offline fixture: the thrown error is captured as a failed case.
describe({
  kind: 'run',
  id: 'fixture-fail',
}, {
  objective: 'cli exit-code fixture (throwing case)',
}, () => {
  it('throws', async () => {
    throw new Error('boom');
  });
});
