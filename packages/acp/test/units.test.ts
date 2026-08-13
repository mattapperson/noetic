/**
 * Unit coverage for the pure helpers behind the ACP client: permission rule
 * matching and option selection, shell-command construction, and tool-call
 * content rendering.
 */

import { describe, expect, test } from 'bun:test';
import type { AcpPermissionOption, AcpRequestPermissionRequest } from '@noetic-tools/types';
import {
  evaluatePolicy,
  resolvePermission,
  ruleMatches,
  selectPermissionOption,
} from '../src/permissions';
import { buildCommandLine, quoteShellArg } from '../src/terminals';
import { renderToolCallContent } from '../src/turn';

//#region Fixtures

function request(
  kind: AcpRequestPermissionRequest['toolCall']['kind'],
  title: string,
  options: AcpPermissionOption[] = [],
): AcpRequestPermissionRequest {
  return {
    sessionId: 'session-1',
    options,
    toolCall: {
      toolCallId: 'call-1',
      title,
      kind,
    },
  };
}

const ALLOW_ONCE: AcpPermissionOption = {
  optionId: 'a1',
  name: 'Allow once',
  kind: 'allow_once',
};
const ALLOW_ALWAYS: AcpPermissionOption = {
  optionId: 'a2',
  name: 'Always',
  kind: 'allow_always',
};
const REJECT_ONCE: AcpPermissionOption = {
  optionId: 'r1',
  name: 'Reject',
  kind: 'reject_once',
};
const REJECT_ALWAYS: AcpPermissionOption = {
  optionId: 'r2',
  name: 'Never',
  kind: 'reject_always',
};

//#endregion

describe('ruleMatches', () => {
  test('an empty rule matches anything', () => {
    expect(ruleMatches({}, request('execute', 'anything').toolCall)).toBe(true);
  });

  test('kind must match exactly', () => {
    expect(
      ruleMatches(
        {
          kind: 'read',
        },
        request('read', 'x').toolCall,
      ),
    ).toBe(true);
    expect(
      ruleMatches(
        {
          kind: 'read',
        },
        request('edit', 'x').toolCall,
      ),
    ).toBe(false);
  });

  test('a string title is a case-insensitive substring match', () => {
    expect(
      ruleMatches(
        {
          title: 'RM -RF',
        },
        request('execute', 'Run rm -rf /tmp').toolCall,
      ),
    ).toBe(true);
    expect(
      ruleMatches(
        {
          title: 'curl',
        },
        request('execute', 'Run rm -rf /tmp').toolCall,
      ),
    ).toBe(false);
  });

  test('a RegExp title is applied as a pattern', () => {
    expect(
      ruleMatches(
        {
          title: /^Read\s/,
        },
        request('read', 'Read a.ts').toolCall,
      ),
    ).toBe(true);
    expect(
      ruleMatches(
        {
          title: /^Read\s/,
        },
        request('read', 'Re-read a.ts').toolCall,
      ),
    ).toBe(false);
  });

  test('all present fields must match together', () => {
    const rule = {
      kind: 'execute',
      title: 'rm',
    } as const;
    expect(ruleMatches(rule, request('execute', 'Run rm').toolCall)).toBe(true);
    expect(ruleMatches(rule, request('read', 'Run rm').toolCall)).toBe(false);
    expect(ruleMatches(rule, request('execute', 'Run ls').toolCall)).toBe(false);
  });
});

describe('evaluatePolicy', () => {
  test('abstains when there is no policy', () => {
    expect(evaluatePolicy(undefined, request('read', 'x'))).toBeUndefined();
  });

  test('abstains when no rule matches', () => {
    expect(
      evaluatePolicy(
        {
          allow: [
            {
              kind: 'read',
            },
          ],
        },
        request('execute', 'x'),
      ),
    ).toBeUndefined();
  });

  test('an allow rule allows', () => {
    const outcome = evaluatePolicy(
      {
        allow: [
          {
            kind: 'read',
          },
        ],
      },
      request('read', 'x'),
    );
    expect(outcome?.decision).toBe('allow');
  });

  test('deny wins over an overlapping allow', () => {
    const outcome = evaluatePolicy(
      {
        allow: [
          {
            kind: 'execute',
          },
        ],
        deny: [
          {
            title: 'rm',
          },
        ],
      },
      request('execute', 'Run rm -rf'),
    );
    expect(outcome?.decision).toBe('deny');
  });
});

describe('selectPermissionOption', () => {
  test('cancel never selects an option', () => {
    expect(
      selectPermissionOption(
        {
          decision: 'cancel',
        },
        [
          ALLOW_ONCE,
        ],
      ),
    ).toEqual({
      outcome: 'cancelled',
    });
  });

  test('an explicit optionId the agent offered is honoured', () => {
    expect(
      selectPermissionOption(
        {
          decision: 'allow',
          optionId: 'a2',
        },
        [
          ALLOW_ONCE,
          ALLOW_ALWAYS,
        ],
      ),
    ).toEqual({
      outcome: 'selected',
      optionId: 'a2',
    });
  });

  test('an optionId the agent did not offer falls back to kind matching', () => {
    expect(
      selectPermissionOption(
        {
          decision: 'allow',
          optionId: 'nonexistent',
        },
        [
          ALLOW_ONCE,
        ],
      ),
    ).toEqual({
      outcome: 'selected',
      optionId: 'a1',
    });
  });

  test('allow prefers allow_once by default', () => {
    expect(
      selectPermissionOption(
        {
          decision: 'allow',
        },
        [
          ALLOW_ALWAYS,
          ALLOW_ONCE,
        ],
      ),
    ).toEqual({
      outcome: 'selected',
      optionId: 'a1',
    });
  });

  test('persist flips the preference to allow_always', () => {
    expect(
      selectPermissionOption(
        {
          decision: 'allow',
        },
        [
          ALLOW_ONCE,
          ALLOW_ALWAYS,
        ],
        true,
      ),
    ).toEqual({
      outcome: 'selected',
      optionId: 'a2',
    });
  });

  test('deny prefers reject_once, and persist flips it to reject_always', () => {
    const options = [
      REJECT_ONCE,
      REJECT_ALWAYS,
    ];
    expect(
      selectPermissionOption(
        {
          decision: 'deny',
        },
        options,
      ),
    ).toEqual({
      outcome: 'selected',
      optionId: 'r1',
    });
    expect(
      selectPermissionOption(
        {
          decision: 'deny',
        },
        options,
        true,
      ),
    ).toEqual({
      outcome: 'selected',
      optionId: 'r2',
    });
  });

  test('cancels when the agent offered nothing matching the decision', () => {
    expect(
      selectPermissionOption(
        {
          decision: 'allow',
        },
        [
          REJECT_ONCE,
        ],
      ),
    ).toEqual({
      outcome: 'cancelled',
    });
  });
});

describe('resolvePermission', () => {
  test('defaults to deny when every tier abstains', async () => {
    const outcome = await resolvePermission(request('execute', 'x'), {});
    expect(outcome.decision).toBe('deny');
    expect(outcome.reason).toBeDefined();
  });

  test('honours an explicit default', async () => {
    const outcome = await resolvePermission(request('execute', 'x'), {
      policy: {
        default: 'allow',
      },
    });
    expect(outcome.decision).toBe('allow');
  });

  test('policy short-circuits steering and the handler', async () => {
    let steered = false;
    let handled = false;
    const outcome = await resolvePermission(request('read', 'x'), {
      policy: {
        allow: [
          {
            kind: 'read',
          },
        ],
      },
      steer: async () => {
        steered = true;
        return undefined;
      },
      handler: async () => {
        handled = true;
        return {
          decision: 'deny',
        };
      },
    });
    expect(outcome.decision).toBe('allow');
    expect(steered).toBe(false);
    expect(handled).toBe(false);
  });

  test('steering short-circuits the handler', async () => {
    let handled = false;
    const outcome = await resolvePermission(request('edit', 'x'), {
      steer: async () => ({
        decision: 'deny',
        reason: 'steering',
      }),
      handler: async () => {
        handled = true;
        return {
          decision: 'allow',
        };
      },
    });
    expect(outcome.decision).toBe('deny');
    expect(outcome.reason).toBe('steering');
    expect(handled).toBe(false);
  });
});

describe('shell command construction', () => {
  test('a bare word is left unquoted', () => {
    expect(quoteShellArg('ls')).toBe('ls');
    expect(quoteShellArg('/usr/bin/env')).toBe('/usr/bin/env');
    expect(quoteShellArg('--flag=value')).toBe('--flag=value');
  });

  test('spaces force quoting so an argument cannot split', () => {
    expect(quoteShellArg('hello world')).toBe("'hello world'");
  });

  test('an embedded single quote uses the POSIX close-escape-reopen idiom', () => {
    expect(quoteShellArg("it's")).toBe(`'it'\\''s'`);
  });

  test('a command with no args is passed through verbatim', () => {
    expect(buildCommandLine('ls')).toBe('ls');
  });

  test('args are quoted and joined', () => {
    expect(
      buildCommandLine('grep', [
        '-n',
        'a b',
        'file.txt',
      ]),
    ).toBe("grep -n 'a b' file.txt");
  });
});

describe('renderToolCallContent', () => {
  test('renders text content', () => {
    expect(
      renderToolCallContent([
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'result',
          },
        },
      ]),
    ).toBe('result');
  });

  test('renders a diff structurally rather than dropping it', () => {
    expect(
      renderToolCallContent([
        {
          type: 'diff',
          path: '/a.ts',
          oldText: 'before',
          newText: 'after',
        },
      ]),
    ).toBe('[diff /a.ts]\nafter');
  });

  test('renders a terminal reference', () => {
    expect(
      renderToolCallContent([
        {
          type: 'terminal',
          terminalId: 'term-1',
        },
      ]),
    ).toBe('[terminal term-1]');
  });

  test('falls back to rawOutput when there is no content', () => {
    expect(
      renderToolCallContent([], {
        ok: true,
      }),
    ).toBe('{"ok":true}');
  });

  test('returns an empty string when there is neither content nor rawOutput', () => {
    expect(renderToolCallContent([])).toBe('');
  });
});
