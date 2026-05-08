import { describe, expect, it } from 'bun:test';

import {
  createCodingTools,
  createReadOnlyTools,
} from '../src/tools/node-factory/core-tools.js';

describe('createCodingTools — availableTools gating', () => {
  it('registers every tool by default', () => {
    const tools = createCodingTools({
      cwd: process.cwd(),
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain('InteractiveTerminal');
    expect(names).toContain('browser');
  });

  it('omits InteractiveTerminal when availableTools.interactiveTerminal is false', () => {
    const tools = createCodingTools({
      cwd: process.cwd(),
      availableTools: {
        interactiveTerminal: false,
      },
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('InteractiveTerminal');
    // Browser should still be there (defaults true).
    expect(names).toContain('browser');
  });

  it('omits browser when availableTools.browser is false', () => {
    const tools = createCodingTools({
      cwd: process.cwd(),
      availableTools: {
        browser: false,
      },
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain('InteractiveTerminal');
    expect(names).not.toContain('browser');
  });

  it('omits both when both flags are false', () => {
    const tools = createCodingTools({
      cwd: process.cwd(),
      availableTools: {
        interactiveTerminal: false,
        browser: false,
      },
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('InteractiveTerminal');
    expect(names).not.toContain('browser');
  });
});

describe('createReadOnlyTools — availableTools gating', () => {
  it('registers InteractiveTerminal by default', () => {
    const tools = createReadOnlyTools({
      cwd: process.cwd(),
    });
    expect(tools.map((t) => t.name)).toContain('InteractiveTerminal');
  });

  it('omits InteractiveTerminal when flagged off', () => {
    const tools = createReadOnlyTools({
      cwd: process.cwd(),
      availableTools: {
        interactiveTerminal: false,
      },
    });
    expect(tools.map((t) => t.name)).not.toContain('InteractiveTerminal');
  });

  it('never registers the browser tool in read-only mode (regardless of flag)', () => {
    const withFlag = createReadOnlyTools({
      cwd: process.cwd(),
      availableTools: {
        browser: true,
      },
    });
    expect(withFlag.map((t) => t.name)).not.toContain('browser');
  });
});
