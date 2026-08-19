/**
 * The JSON-workflow schema hand-maintains Zod copies of a few ACP unions, since
 * a JSON document needs a validator and the protocol package ships TypeScript
 * types rather than runtime schemas.
 *
 * Hand-maintained copies drift. These tests compare each copy against the
 * upstream package so an added `ToolKind` (or a changed `McpServer` shape) fails
 * here rather than becoming silently unrepresentable in a workflow document.
 */

import { describe, expect, test } from 'bun:test';
import type * as acp from '@zed-industries/agent-client-protocol';
import { WorkflowNodeSchema } from '../src/schemas/workflow';

/**
 * Pull the enum members our schema accepts for a field of the `acp-agent` node,
 * by probing: the schema is a discriminated union, so validating a candidate
 * document is the reliable way to ask "is this value accepted?".
 */
function acceptedToolKinds(candidates: ReadonlyArray<string>): string[] {
  return candidates.filter(
    (kind) =>
      WorkflowNodeSchema.safeParse({
        kind: 'acp-agent',
        id: 'probe',
        agent: 'a',
        prompt: 'p',
        permissions: {
          allow: [
            {
              kind,
            },
          ],
        },
      }).success,
  );
}

describe('AcpToolKindSchema tracks the protocol package', () => {
  /**
   * Every member of the upstream `ToolKind` union, listed so TypeScript fails
   * this file if upstream adds or removes one — the compiler checks the literal
   * against the real type, and the test checks the runtime schema against the
   * literal.
   */
  const UPSTREAM_TOOL_KINDS: ReadonlyArray<acp.ToolKind> = [
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'think',
    'fetch',
    'switch_mode',
    'other',
  ];

  test('accepts every upstream tool kind', () => {
    expect(acceptedToolKinds(UPSTREAM_TOOL_KINDS).sort()).toEqual(
      [
        ...UPSTREAM_TOOL_KINDS,
      ].sort(),
    );
  });

  test('rejects a value that is not an upstream tool kind', () => {
    expect(
      acceptedToolKinds([
        'not_a_real_kind',
      ]),
    ).toEqual([]);
  });
});

describe('AcpMcpServerSchema tracks the protocol package', () => {
  /** Typed as the upstream union, so a shape change fails to compile here. */
  const STDIO: acp.McpServer = {
    name: 'db',
    command: 'mcp-db',
    args: [],
    env: [],
  };
  const HTTP: acp.McpServer = {
    type: 'http',
    name: 'db',
    url: 'https://example.test/mcp',
    headers: [],
  };
  const SSE: acp.McpServer = {
    type: 'sse',
    name: 'db',
    url: 'https://example.test/mcp',
    headers: [],
  };

  test.each([
    [
      'stdio',
      STDIO,
    ],
    [
      'http',
      HTTP,
    ],
    [
      'sse',
      SSE,
    ],
  ])('accepts an upstream %s server verbatim', (_label, server) => {
    expect(
      WorkflowNodeSchema.safeParse({
        kind: 'acp-agent',
        id: 'probe',
        agent: 'a',
        prompt: 'p',
        mcpServers: [
          server,
        ],
      }).success,
    ).toBe(true);
  });

  test('rejects a server matching no upstream transport', () => {
    expect(
      WorkflowNodeSchema.safeParse({
        kind: 'acp-agent',
        id: 'probe',
        agent: 'a',
        prompt: 'p',
        mcpServers: [
          {
            type: 'carrier-pigeon',
            name: 'db',
          },
        ],
      }).success,
    ).toBe(false);
  });
});
