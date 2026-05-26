import { describe, expect, it } from 'bun:test';

import { BINARY_MANIFEST } from '../src/setup/binary-manifest.js';
import { describeIgnoreImpact } from '../src/tui/screens/setup-screen.js';

function descriptorFor(id: 'rtk' | 'pilotty' | 'agent-browser') {
  const descriptor = BINARY_MANIFEST.find((d) => d.id === id);
  if (!descriptor) {
    throw new Error('unreachable');
  }
  return descriptor;
}

describe('describeIgnoreImpact', () => {
  it('says the bash tool will be degraded when rtk is ignored', () => {
    const text = describeIgnoreImpact(descriptorFor('rtk'));
    expect(text).toContain('bash');
    expect(text).toContain('degraded');
  });

  it('says the interactive-terminal tool will be omitted when pilotty is ignored', () => {
    const text = describeIgnoreImpact(descriptorFor('pilotty'));
    expect(text).toContain('interactive-terminal');
    expect(text).toContain('not be registered');
  });

  it('says the browser tool will be omitted when agent-browser is ignored', () => {
    const text = describeIgnoreImpact(descriptorFor('agent-browser'));
    expect(text).toContain('browser');
    expect(text).toContain('not be registered');
  });
});
