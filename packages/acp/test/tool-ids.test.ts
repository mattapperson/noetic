import { describe, expect, it } from 'bun:test';
import type { AcpToolCallUpdate } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { claudeCode, codex, gemini } from '../src/agents';
import { claudeToolId, codexToolId } from '../src/tool-ids';

function call(fields: Partial<AcpToolCallUpdate>): AcpToolCallUpdate {
  return frameworkCast<AcpToolCallUpdate>({
    sessionUpdate: 'tool_call',
    toolCallId: 'c',
    title: 'A call',
    ...fields,
  });
}

describe('claudeToolId', () => {
  it("reads Claude Code's own tool name, and an MCP tool's server and name", () => {
    expect(
      claudeToolId(
        call({
          _meta: {
            claudeCode: {
              toolName: 'Read',
            },
          },
        }),
      ),
    ).toEqual({
      id: 'Read',
    });
    expect(
      claudeToolId(
        call({
          _meta: {
            claudeCode: {
              toolName: 'mcp__sw_workspace__read_file',
            },
          },
        }),
      ),
    ).toEqual({
      id: 'read_file',
      server: 'sw_workspace',
    });
  });

  it('says nothing when the update does not name the tool', () => {
    expect(claudeToolId(call({}))).toBeUndefined();
    expect(
      claudeToolId(
        call({
          _meta: {
            claudeCode: {
              toolName: '',
            },
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      claudeToolId(
        call({
          _meta: {
            claudeCode: 'Read',
          },
        }),
      ),
    ).toBeUndefined();
  });
});

describe('codexToolId', () => {
  it("reads an MCP call's server and tool from its input, or its title", () => {
    expect(
      codexToolId(
        call({
          _meta: {
            is_mcp_tool_call: true,
          },
          rawInput: {
            server: 'sw_workspace',
            tool: 'read_file',
            arguments: {},
          },
        }),
      ),
    ).toEqual({
      id: 'read_file',
      server: 'sw_workspace',
    });
    expect(
      codexToolId(
        call({
          title: 'mcp.sw_workspace.read_file',
        }),
      ),
    ).toEqual({
      id: 'read_file',
      server: 'sw_workspace',
    });
  });

  it('says nothing for a call Codex names by title only', () => {
    expect(
      codexToolId(
        call({
          title: 'Run ls',
        }),
      ),
    ).toBeUndefined();
    expect(
      codexToolId(
        call({
          rawInput: {
            server: 's',
            tool: 't',
          },
          title: undefined,
        }),
      ),
    ).toBeUndefined();
  });
});

describe('presets', () => {
  it('give Claude Code and Codex their readers, and others none', () => {
    expect(claudeCode().toolIdOf).toBe(claudeToolId);
    expect(codex().toolIdOf).toBe(codexToolId);
    expect(gemini().toolIdOf).toBeUndefined();
  });
});
