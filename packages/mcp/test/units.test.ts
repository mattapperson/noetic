import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError } from '@noetic-tools/types';
import { resolveMcpConfig } from '../src/config';
import { resourceValue, storeInlineBlobs, toolResultOutput } from '../src/content';
import { mostCautious, overForgivingDeterminism, overTrustedSenses } from '../src/declaration';
import { requestErrorPayload, toolErrorPayload } from '../src/errors';
import { coverageUri, parseAnomalies, parseCoverage } from '../src/evidence';
import { createMemoryArtifactStore } from '../src/memory-artifacts';
import { mcp } from '../src/provider';
import { originAwareFetch } from '../src/transports';
import { generateWebhookSecret, signWebhook, verifyWebhook } from '../src/webhooks';

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected a throw');
  } catch (error) {
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('CONNECTION_INVALID');
  }
}

describe('resolveMcpConfig', () => {
  it("takes ACP's McpServer shapes as they stand and a transport", () => {
    const http = resolveMcpConfig({
      name: 'linear',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: [
        {
          name: 'X-Tenant',
          value: 't',
        },
      ],
      timeoutMs: 5,
      pollIntervalMs: 7,
    });
    expect(http.target).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: [
        {
          name: 'X-Tenant',
          value: 't',
        },
      ],
    });
    expect(http.options).toEqual({
      name: 'linear',
      timeoutMs: 5,
      pollIntervalMs: 7,
    });
    const stdio = resolveMcpConfig({
      name: 'files',
      command: 'node',
      args: [
        'x.js',
      ],
      env: [
        {
          name: 'A',
          value: '1',
        },
      ],
      cwd: '/tmp',
    });
    expect(stdio.target).toEqual({
      command: 'node',
      args: [
        'x.js',
      ],
      env: [
        {
          name: 'A',
          value: '1',
        },
      ],
      cwd: '/tmp',
    });
    expect(
      resolveMcpConfig({
        type: 'stdio',
        command: 'node',
      }).target,
    ).toEqual({
      type: 'stdio',
      command: 'node',
    });
    const factory = (): never => {
      throw new Error('unused');
    };
    expect(
      resolveMcpConfig({
        transport: factory,
      }).target,
    ).toEqual({
      transport: factory,
    });
  });

  it("drops ACP's _meta, on the server and on each value", () => {
    // A variable, as an ACP config arrives: `_meta` is ACP's extension point.
    const server = {
      name: 'linear',
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: [
        {
          name: 'X-Tenant',
          value: 't',
          _meta: {
            note: 'x',
          },
        },
      ],
      _meta: {
        note: 'x',
      },
    } as const;
    const resolved = resolveMcpConfig(server);
    expect(resolved.options).toEqual({
      name: 'linear',
    });
    expect(resolved.target).not.toHaveProperty('_meta');
  });

  it('refuses malformed configurations with CONNECTION_INVALID', () => {
    expectInvalid(() =>
      mcp({
        command: '',
      }),
    );
    expectInvalid(() =>
      mcp({
        type: 'http',
        url: 'not a url',
      }),
    );
    expectInvalid(() =>
      mcp({
        command: 'server',
        timeoutMs: -1,
      }),
    );
  });

  it('refuses the shapes ACP does not use with CONNECTION_INVALID', () => {
    // A URL with no `type`: ACP always tags a remote server.
    expectInvalid(() => resolveMcpConfig(JSON.parse('{ "url": "https://mcp.example.com/mcp" }')));
    // `protocol` is not an ACP field.
    expectInvalid(() =>
      resolveMcpConfig(
        JSON.parse('{ "type": "http", "url": "https://mcp.example.com/mcp", "protocol": "sse" }'),
      ),
    );
    // Headers and environment as records, not `[{ name, value }]`.
    expectInvalid(() =>
      resolveMcpConfig(
        JSON.parse(
          '{ "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "A": "1" } }',
        ),
      ),
    );
    expectInvalid(() => resolveMcpConfig(JSON.parse('{ "command": "node", "env": { "A": "1" } }')));
    // A command line as a string.
    expectInvalid(() => resolveMcpConfig(JSON.parse('"npx server"')));
  });

  it('refuses a header or environment variable given twice with CONNECTION_INVALID', () => {
    expectInvalid(() =>
      mcp({
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: [
          {
            name: 'X-Tenant',
            value: 'a',
          },
          {
            name: 'x-tenant',
            value: 'b',
          },
        ],
      }),
    );
    expectInvalid(() =>
      mcp({
        command: 'node',
        env: [
          {
            name: 'A',
            value: '1',
          },
          {
            name: 'A',
            value: '2',
          },
        ],
      }),
    );
    // Environment names are case-sensitive, so `A` and `a` are two variables.
    expect(
      mcp({
        command: 'node',
        env: [
          {
            name: 'A',
            value: '1',
          },
          {
            name: 'a',
            value: '2',
          },
        ],
      }).config.target,
    ).toHaveProperty('env');
  });
});

describe('Standard Webhooks', () => {
  const body = '{"type":"event"}';

  it('verifies a signed delivery and drops a duplicate id', async () => {
    const secret = generateWebhookSecret();
    const headers = await signWebhook({
      secret,
      id: 'msg_1',
      timestampSec: 1e9,
      body,
    });
    const seen = new Set<string>();
    expect(
      await verifyWebhook({
        secret,
        delivery: {
          headers,
          body,
        },
        nowSec: 1e9 + 10,
        seen,
      }),
    ).toEqual({
      ok: true,
      id: 'msg_1',
    });
    expect(
      await verifyWebhook({
        secret,
        delivery: {
          headers,
          body,
        },
        nowSec: 1e9 + 10,
        seen,
      }),
    ).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('accepts any v1 entry of a rotated signature list', async () => {
    const secret = generateWebhookSecret();
    const headers = await signWebhook({
      secret,
      id: 'msg_2',
      timestampSec: 1e9,
      body,
    });
    const rotated = {
      ...headers,
      'webhook-signature': `v1,AAAA ${headers['webhook-signature']}`,
    };
    const verified = await verifyWebhook({
      secret,
      delivery: {
        headers: rotated,
        body,
      },
      nowSec: 1e9,
    });
    expect(verified.ok).toBe(true);
  });

  it('enforces the five-minute window at its boundary', async () => {
    const secret = generateWebhookSecret();
    const headers = await signWebhook({
      secret,
      id: 'msg_3',
      timestampSec: 1e9,
      body,
    });
    const at = async (nowSec: number): Promise<boolean> =>
      (
        await verifyWebhook({
          secret,
          delivery: {
            headers,
            body,
          },
          nowSec,
        })
      ).ok;
    expect(await at(1e9 + 299)).toBe(true);
    expect(await at(1e9 + 300)).toBe(true);
    expect(await at(1e9 + 301)).toBe(false);
    expect(await at(1e9 - 301)).toBe(false);
  });

  it('refuses a tampered body, a bad timestamp and missing headers', async () => {
    const secret = generateWebhookSecret();
    const headers = await signWebhook({
      secret,
      id: 'msg_4',
      timestampSec: 1e9,
      body,
    });
    expect(
      await verifyWebhook({
        secret,
        delivery: {
          headers,
          body: '{"type":"gap"}',
        },
        nowSec: 1e9,
      }),
    ).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(
      await verifyWebhook({
        secret,
        delivery: {
          headers: {
            ...headers,
            'webhook-timestamp': 'soon',
          },
          body,
        },
        nowSec: 1e9,
      }),
    ).toEqual({
      ok: false,
      reason: 'bad_timestamp',
    });
    expect(
      await verifyWebhook({
        secret,
        delivery: {
          headers: {},
          body,
        },
        nowSec: 1e9,
      }),
    ).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });
});

describe('originAwareFetch', () => {
  function recorder(
    redirects: Record<
      string,
      [
        number,
        string,
      ]
    >,
  ): {
    fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
    seen: Array<{
      url: string;
      headers: Headers;
      method: string | undefined;
    }>;
  } {
    const seen: Array<{
      url: string;
      headers: Headers;
      method: string | undefined;
    }> = [];
    return {
      seen,
      fetch: async (url, init) => {
        const href = String(url);
        seen.push({
          url: href,
          headers: new Headers(init?.headers),
          method: init?.method,
        });
        const redirect = redirects[href];
        if (redirect === undefined) {
          return new Response('ok');
        }
        return new Response(null, {
          status: redirect[0],
          headers: {
            location: redirect[1],
          },
        });
      },
    };
  }

  it('keeps configured headers on a same-origin redirect and drops them across origins', async () => {
    const base = recorder({
      'https://a.test/mcp': [
        307,
        'https://a.test/v2',
      ],
      'https://a.test/v2': [
        307,
        'https://b.test/mcp',
      ],
    });
    const guarded = originAwareFetch(
      {
        'X-Tenant': 'secret',
      },
      base.fetch,
    );
    await guarded('https://a.test/mcp', {
      method: 'POST',
      headers: {
        'X-Tenant': 'secret',
        'content-type': 'application/json',
      },
    });
    expect(base.seen.map((s) => s.headers.get('x-tenant'))).toEqual([
      'secret',
      'secret',
      null,
    ]);
    expect(base.seen.at(-1)?.headers.get('content-type')).toBe('application/json');
  });

  it('turns a 303 into a bodyless GET', async () => {
    const base = recorder({
      'https://a.test/mcp': [
        303,
        'https://a.test/done',
      ],
    });
    await originAwareFetch({}, base.fetch)('https://a.test/mcp', {
      method: 'POST',
      body: 'x',
    });
    expect(base.seen.map((s) => s.method)).toEqual([
      'POST',
      'GET',
    ]);
  });
});

describe('trust orderings', () => {
  it('flags senses declared more trustworthy than OVP defaults, not less', () => {
    expect(
      overTrustedSenses({
        ui: {
          independence: 'independent',
          grade: 'presence',
        },
        net: {
          independence: 'actuation-derived',
          grade: 'context',
        },
        log: {
          independence: 'independent',
          grade: 'consequence',
        },
        'x-exit': {
          independence: 'independent',
          grade: 'consequence',
        },
      }),
    ).toEqual([
      'ui',
      'log',
    ]);
  });

  it('flags determinism fields more forgiving than the profile default', () => {
    const strict = {
      reset: 'none',
      replayPrefix: 'unsafe',
      time: 'wall',
      observation: 'sampled',
      actions: 'irreversible',
    } as const;
    const loose = {
      reset: 'cheap',
      replayPrefix: 'free',
      time: 'stepped',
      observation: 'exact',
      actions: 'reversible',
    } as const;
    expect(overForgivingDeterminism(strict, loose)).toEqual([]);
    expect(overForgivingDeterminism(loose, strict)).toEqual([
      'reset',
      'replayPrefix',
      'time',
      'observation',
      'actions',
    ]);
  });
});

describe('error mapping', () => {
  it('fills in candidates for an ambiguous refusal that lacks them', () => {
    expect(
      toolErrorPayload({
        isError: true,
        structuredContent: {
          code: 'ambiguous',
          message: 'many',
        },
      }),
    ).toEqual({
      code: 'ambiguous',
      message: 'many',
      details: {
        candidates: [],
      },
    });
  });

  it('maps protocol errors onto codes', async () => {
    const { McpError, ErrorCode } = await import('@modelcontextprotocol/sdk/types.js');
    expect(requestErrorPayload(new McpError(ErrorCode.InvalidParams, 'bad')).code).toBe(
      'malformed',
    );
    expect(requestErrorPayload(new McpError(ErrorCode.MethodNotFound, 'what')).code).toBe(
      'undeclared',
    );
    expect(requestErrorPayload(new McpError(ErrorCode.InternalError, 'oops')).code).toBe(
      'unavailable',
    );
    expect(requestErrorPayload('plain').message).toBe('plain');
  });
});

describe('content conversion', () => {
  it('stores audio and embedded binary resources as blobs, keeping text', async () => {
    const artifacts = createMemoryArtifactStore();
    const output = await toolResultOutput(
      {
        content: [
          {
            type: 'audio',
            data: btoa('wav'),
            mimeType: 'audio/wav',
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///x',
              blob: btoa('zip'),
              mimeType: 'application/zip',
            },
          },
          {
            type: 'text',
            text: 'note',
          },
        ],
      },
      artifacts,
    );
    expect(output).toMatchObject({
      content: [
        {
          $blob: {
            mimeType: 'audio/wav',
            bytes: 3,
          },
        },
        {
          $blob: {
            mimeType: 'application/zip',
          },
        },
        {
          type: 'text',
          text: 'note',
        },
      ],
    });
  });

  it('stores identical content once', async () => {
    const artifacts = createMemoryArtifactStore();
    const value = {
      $blob: {
        data: btoa('same'),
        mimeType: 'text/plain',
      },
    };
    const [a, b] = await Promise.all([
      storeInlineBlobs(value, artifacts),
      storeInlineBlobs(value, artifacts),
    ]);
    expect(a).toEqual(b);
  });

  it('reads JSON, text and binary resource contents', async () => {
    const artifacts = createMemoryArtifactStore();
    expect(
      await resourceValue(
        [
          {
            uri: 'a',
            mimeType: 'text/plain',
            text: 'hi',
          },
        ],
        artifacts,
      ),
    ).toBe('hi');
    const many = await resourceValue(
      [
        {
          uri: 'a',
          mimeType: 'application/vnd.x+json',
          text: '{"a":1}',
        },
        {
          uri: 'b',
          blob: btoa('bin'),
        },
      ],
      artifacts,
    );
    expect(many).toMatchObject([
      {
        a: 1,
      },
      {
        $blob: {
          mimeType: 'application/octet-stream',
        },
      },
    ]);
  });
});

describe('evidence', () => {
  it('builds coverage URIs and parses blind spots and anomalies', () => {
    expect(coverageUri(null)).toBe('noetic://coverage');
    expect(coverageUri('c 1')).toBe('noetic://coverage?since=c%201');
    expect(
      parseCoverage({
        blindSpots: [
          {
            kind: 'redacted',
            detail: 'masked',
            impeaching: false,
            remedy: 'unmask',
          },
        ],
      }),
    ).toEqual([
      {
        kind: 'redacted',
        detail: 'masked',
        impeaching: false,
        remedy: 'unmask',
      },
    ]);
    expect(
      parseCoverage([
        {
          kind: 'made-up',
        },
      ]),
    ).toBeUndefined();
    expect(
      parseAnomalies([
        {
          kind: 'k',
          tier: 'advisory',
          claim: 'c',
          counter: 'd',
          between: [
            'ui',
            'net',
          ],
          evidence: [],
        },
      ]),
    ).toHaveLength(1);
    expect(
      parseAnomalies({
        anomalies: [
          {
            kind: 'k',
            tier: 'certain',
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe('memory artifact store', () => {
  it('links blobs to runs and drops unlinked content on clearRun', async () => {
    const store = createMemoryArtifactStore();
    const ref = await store.put(new TextEncoder().encode('abc'), {
      mimeType: 'text/plain',
      name: 'a.txt',
    });
    expect(ref.$blob.sha256).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    await store.attach(ref.$blob.uri, {
      executionId: 'run-1',
      source: 'kiosk',
    });
    expect(await store.listRun('run-1')).toHaveLength(1);
    const stream = await store.get(ref.$blob.uri);
    assert(stream !== null);
    expect(await new Response(stream).text()).toBe('abc');
    await store.clearRun('run-1');
    expect(await store.head(ref.$blob.uri)).toBeNull();
    expect(await store.get('artifact://sha256/none')).toBeNull();
  });
});

describe('createTransport', () => {
  it('builds the transport each target asks for, without starting it', async () => {
    const { createTransport } = await import('../src/transports');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    expect(
      await createTransport({
        command: 'node',
        args: [
          'server.js',
        ],
        env: [
          {
            name: 'A',
            value: '1',
          },
        ],
        cwd: '/tmp',
      }),
    ).toBeInstanceOf(StdioClientTransport);
    expect(
      await createTransport({
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        headers: [
          {
            name: 'X-Tenant',
            value: 't',
          },
        ],
      }),
    ).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(
      await createTransport({
        type: 'sse',
        url: 'https://mcp.example.test/sse',
      }),
    ).toBeInstanceOf(SSEClientTransport);
  });
});

describe('mostCautious', () => {
  it('takes the least forgiving value of each field, not one whole determinism', () => {
    expect(
      mostCautious(
        {
          reset: 'cheap',
          replayPrefix: 'unsafe',
          time: 'wall',
          observation: 'exact',
          actions: 'reversible',
        },
        {
          reset: 'none',
          replayPrefix: 'free',
          time: 'stepped',
          observation: 'sampled',
          actions: 'reversible',
        },
      ),
    ).toEqual({
      reset: 'none',
      replayPrefix: 'unsafe',
      time: 'wall',
      observation: 'sampled',
      actions: 'reversible',
    });
    expect(mostCautious(undefined, undefined)).toBeUndefined();
  });
});
