import { describe, expect, it } from 'bun:test';
import { geminiToolNameMatches, namesBridgedToolCall } from '../src/types/acp';

describe('namesBridgedToolCall', () => {
  it('matches each agent title form exactly', () => {
    for (const title of [
      'mcp__noetic__echo',
      'mcp.noetic.echo',
      'noetic_echo',
    ]) {
      expect(
        namesBridgedToolCall('noetic', 'echo', {
          toolCallId: 'x',
          title,
        }),
      ).toBe(true);
    }
    expect(
      namesBridgedToolCall('noetic', 'get', {
        toolCallId: 'x',
        title: 'mcp__noetic__cache_get',
      }),
    ).toBe(false);
  });

  it('matches a Gemini CLI call id whatever its display title', () => {
    expect(
      namesBridgedToolCall('noetic', 'echo', {
        toolCallId: 'mcp_noetic_echo__call_61997',
        title: 'echo(text: hi)',
      }),
    ).toBe(true);
  });
});

describe('geminiToolNameMatches', () => {
  it('matches the full name, including a name with its own double underscore', () => {
    expect(geminiToolNameMatches('noetic', 'a__b', 'mcp_noetic_a__b__call_1')).toBe(true);
    expect(geminiToolNameMatches('noetic', 'echo', 'mcp_noetic_echo__call_1')).toBe(true);
  });

  it('matches a name Gemini shortened in the middle', () => {
    const wire = `len56_${'x'.repeat(50)}`;
    expect(
      geminiToolNameMatches('noetic', wire, `mcp_noetic_len56_xxx...${'x'.repeat(10)}__call_9`),
    ).toBe(true);
    expect(geminiToolNameMatches('noetic', wire, 'mcp_noetic_len64_xxx...xxxx__call_9')).toBe(
      false,
    );
  });

  it('refuses other servers, other tools, and other id shapes', () => {
    expect(geminiToolNameMatches('noetic', 'echo', 'mcp_github_echo__call_1')).toBe(false);
    expect(geminiToolNameMatches('noetic', 'echo', 'mcp_noetic_echo2__call_1')).toBe(false);
    expect(geminiToolNameMatches('noetic', 'echo', 'run_shell_command__call_1')).toBe(false);
    expect(geminiToolNameMatches('noetic', 'echo', 'mcp_noetic___call_1')).toBe(false);
  });
});
