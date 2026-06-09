import { describe, expect, test } from 'bun:test';
import { renderTemplate } from '../src/adapters/worktree.js';

describe('renderTemplate', () => {
  const vars = {
    repo: 'noetic',
    repo_path: '/Users/me/dev/noetic',
    branch: 'feature/auth',
    worktree_path: '',
    worktree_name: '',
    default_branch: 'main',
    agent_id: 'agent-abc123',
  };

  test('substitutes a single variable', () => {
    expect(renderTemplate('hello {{ repo }}', vars)).toBe('hello noetic');
  });

  test('substitutes multiple variables in one template', () => {
    expect(renderTemplate('{{ repo_path }}/{{ agent_id }}', vars)).toBe(
      '/Users/me/dev/noetic/agent-abc123',
    );
  });

  test('unknown variables expand to empty string', () => {
    expect(renderTemplate('a {{ does_not_exist }} b', vars)).toBe('a  b');
  });

  test('sanitize filter strips slashes and lowercases', () => {
    expect(renderTemplate('{{ branch | sanitize }}', vars)).toBe('feature-auth');
  });

  test('sanitize filter strips backslashes too', () => {
    expect(
      renderTemplate('{{ x | sanitize }}', {
        ...vars,
        x: 'a\\b/c',
      }),
    ).toBe('a-b-c');
  });

  test('hash_port filter is deterministic and in [10000,19999]', () => {
    const port1 = renderTemplate('{{ branch | hash_port }}', vars);
    const port2 = renderTemplate('{{ branch | hash_port }}', vars);
    expect(port1).toBe(port2);
    const n = Number(port1);
    expect(n).toBeGreaterThanOrEqual(10_000);
    expect(n).toBeLessThanOrEqual(19_999);
  });

  test('different inputs hash to different ports (with very high probability)', () => {
    const a = renderTemplate('{{ x | hash_port }}', {
      ...vars,
      x: 'feature-a',
    });
    const b = renderTemplate('{{ x | hash_port }}', {
      ...vars,
      x: 'feature-b',
    });
    expect(a).not.toBe(b);
  });

  test('unknown filter passes raw value through', () => {
    expect(renderTemplate('{{ repo | nonexistent }}', vars)).toBe('noetic');
  });

  test('default worktree-path template renders to a sane path', () => {
    const out = renderTemplate('{{ repo_path }}/../{{ repo }}.{{ agent_id | sanitize }}', vars);
    expect(out).toBe('/Users/me/dev/noetic/../noetic.agent-abc123');
  });

  test('autoQuote wraps every substitution in single quotes (shell-injection defense)', () => {
    const out = renderTemplate(
      'echo {{ name }}',
      {
        ...vars,
        name: '$(rm -rf /)',
      },
      {
        autoQuote: true,
      },
    );
    // The substitution is single-quoted, so the shell sees a literal arg, not a substitution.
    expect(out).toBe("echo '$(rm -rf /)'");
  });

  test('autoQuote escapes embedded single quotes via the standard idiom', () => {
    const out = renderTemplate(
      'msg {{ x }}',
      {
        ...vars,
        x: "it's fine",
      },
      {
        autoQuote: true,
      },
    );
    expect(out).toBe(`msg 'it'\\''s fine'`);
  });

  test('hash_port boundary: output is always within [10000, 19999]', () => {
    // Sample many inputs to confirm the [floor, floor+range) invariant holds.
    for (const seed of [
      '',
      'a',
      'aaaa',
      'feature/very/long/branch/name/that/keeps/going',
    ]) {
      const port = Number(
        renderTemplate('{{ x | hash_port }}', {
          ...vars,
          x: seed,
        }),
      );
      expect(port).toBeGreaterThanOrEqual(10_000);
      expect(port).toBeLessThan(20_000);
    }
  });

  test('sanitize: empty string passes through', () => {
    expect(
      renderTemplate('{{ x | sanitize }}', {
        ...vars,
        x: '',
      }),
    ).toBe('');
  });

  test('sanitize: all-special characters become all dashes', () => {
    expect(
      renderTemplate('{{ x | sanitize }}', {
        ...vars,
        x: '@@!!##',
      }),
    ).toBe('------');
  });
});
