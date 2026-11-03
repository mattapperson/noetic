/**
 * What a runner with an allowlist lets a host start — command, environment
 * names, and working directory — and where the host forwards the requests a
 * reached port receives.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStart } from '../src/runner/grants';
import { bridgeTarget } from '../src/runner/host';
import type { FrameLink } from '../src/runner/protocol';
import { serveAcpRunner } from '../src/runner/serve';

const BIN = join(import.meta.dir, '..', 'src', 'bin.ts');

const node = {
  command: 'node',
  args: [
    '-e',
    '0',
  ],
};

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runner-grants-')));
  mkdirSync(join(root, 'repo'));
  return root;
}

describe('checkStart', () => {
  it('starts anything anywhere without an allowlist', () => {
    const root = workspace();
    expect(
      checkStart(
        {
          ...node,
          env: {
            NODE_OPTIONS: '--require x',
          },
          cwd: tmpdir(),
        },
        {
          cwd: root,
        },
      ),
    ).toBe(realpathSync(tmpdir()));
  });

  it('refuses a command it was not granted', () => {
    expect(() =>
      checkStart(
        {
          command: 'node',
          args: [
            '-e',
            '1',
          ],
          env: {},
        },
        {
          allow: [
            node,
          ],
        },
      ),
    ).toThrow("does not start 'node -e 1'");
  });

  it('refuses an environment name the grant does not list', () => {
    const root = workspace();
    for (const name of [
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'PATH',
    ]) {
      expect(() =>
        checkStart(
          {
            ...node,
            env: {
              [name]: 'x',
            },
          },
          {
            allow: [
              node,
            ],
            cwd: root,
          },
        ),
      ).toThrow(`does not let a host set ${name}`);
    }
  });

  it('lets a host set the names its grant lists', () => {
    const root = workspace();
    expect(
      checkStart(
        {
          ...node,
          env: {
            CODEX_CONFIG: '{}',
          },
        },
        {
          allow: [
            {
              ...node,
              env: [
                'CODEX_CONFIG',
              ],
            },
          ],
          cwd: root,
        },
      ),
    ).toBe(root);
  });

  it('starts inside the runner directory, and nowhere else', () => {
    const root = workspace();
    const allow = [
      node,
    ];
    const at = (cwd: string): string =>
      checkStart(
        {
          ...node,
          env: {},
          cwd,
        },
        {
          allow,
          cwd: join(root, 'repo'),
        },
      );
    expect(at(join(root, 'repo'))).toBe(join(root, 'repo'));
    expect(() => at(root)).toThrow('starts nothing outside');
    expect(() => at(join(root, 'repo', '..'))).toThrow('starts nothing outside');
    symlinkSync(root, join(root, 'repo', 'up'));
    expect(() => at(join(root, 'repo', 'up'))).toThrow('starts nothing outside');
    expect(() => at(join(root, 'missing'))).toThrow('does not exist');
  });
});

describe('serveAcpRunner with an allowlist', () => {
  it('runs no loader the host names, even for a granted command', async () => {
    const root = workspace();
    const mark = join(root, 'PWNED');
    const hook = join(root, 'hook.cjs');
    await Bun.write(hook, `require('fs').writeFileSync(${JSON.stringify(mark)}, 'ran')`);
    const sent: Array<{
      t: string;
      id?: string;
      message?: string;
    }> = [];
    const frames: Array<(frame: unknown) => void> = [];
    const closes: Array<() => void> = [];
    const link: FrameLink = {
      send: (frame) => {
        sent.push(Object(frame));
      },
      onFrame: (listener) => {
        frames.push(listener);
      },
      onClose: (listener) => {
        closes.push(() => listener());
      },
      close: async () => {
        for (const close of closes) {
          close();
        }
      },
    };
    const served = serveAcpRunner(link, {
      allow: [
        {
          command: process.execPath,
          args: [
            '-e',
            '0',
          ],
        },
      ],
      cwd: root,
    });
    for (const frame of frames) {
      frame({
        t: 'start',
        id: 'h1',
        command: process.execPath,
        args: [
          '-e',
          '0',
        ],
        env: {
          NODE_OPTIONS: `--require ${hook}`,
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await link.close();
    await served;
    expect(sent).toEqual([
      {
        t: 'error',
        id: 'h1',
        message: `This runner does not let a host set NODE_OPTIONS for '${process.execPath}'.`,
      },
    ]);
    expect(existsSync(mark)).toBe(false);
  });
});

describe('noetic-acp serve grants', () => {
  /** Send `frames` to a stdio runner started with `flags`; the first answer to each id. */
  async function answers(
    flags: string[],
    frames: Array<Record<string, unknown>>,
  ): Promise<Record<string, string>> {
    const child = spawn(
      process.execPath,
      [
        BIN,
        'serve',
        '--stdio',
        ...flags,
      ],
      {
        stdio: [
          'pipe',
          'pipe',
          'inherit',
        ],
      },
    );
    const seen: Record<string, string> = {};
    let buffered = '';
    const done = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const frame = JSON.parse(line);
          if (frame.t !== 'started' && frame.t !== 'error') {
            continue;
          }
          seen[frame.id] = frame.t === 'error' ? frame.message : 'started';
          if (Object.keys(seen).length === frames.length) {
            resolve();
          }
        }
      });
    });
    for (const frame of frames) {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    }
    await done;
    child.kill();
    return seen;
  }

  it('starts a --spawn command with the --env names, and refuses others', async () => {
    const start = (id: string, env: Record<string, string>) => ({
      t: 'start',
      id,
      command: 'sh',
      args: [
        '-c',
        'exit',
      ],
      env,
    });
    const seen = await answers(
      [
        '--agent',
        'codex',
        '--spawn',
        'sh -c exit',
        '--env',
        'GITHUB_TOKEN',
      ],
      [
        start('h1', {
          GITHUB_TOKEN: 't',
        }),
        start('h2', {
          NODE_OPTIONS: '--require x',
        }),
        {
          t: 'start',
          id: 'h3',
          command: 'npx',
          args: [
            '-y',
            '@agentclientprotocol/codex-acp',
          ],
          env: {
            NODE_OPTIONS: '--require x',
          },
        },
      ],
    );
    expect(seen.h1).toBe('started');
    expect(seen.h2).toContain('does not let a host set NODE_OPTIONS');
    expect(seen.h3).toContain('does not let a host set NODE_OPTIONS');
  });
});

describe('bridgeTarget', () => {
  const bridges = new Map([
    [
      '/mcp/abc',
      'http://127.0.0.1:4321',
    ],
  ]);

  it('forwards the checked path to the bridge origin', () => {
    expect(bridgeTarget(bridges, '/mcp/abc?x=1')?.href).toBe('http://127.0.0.1:4321/mcp/abc?x=1');
  });

  it('never leaves the bridge origin for a path that only parses to it', () => {
    for (const path of [
      '0/../mcp/abc',
      '1/../mcp/abc?x',
      'a:/mcp/abc',
      '//evil.example/mcp/abc',
    ]) {
      const target = bridgeTarget(bridges, path);
      assert(target);
      expect(target.origin).toBe('http://127.0.0.1:4321');
      expect(target.pathname).toBe('/mcp/abc');
    }
  });

  it('forwards nothing for a path no bridge serves', () => {
    expect(bridgeTarget(bridges, '/other')).toBeUndefined();
  });
});
