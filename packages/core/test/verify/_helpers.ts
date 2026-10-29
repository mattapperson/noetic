/**
 * Test doubles for `step.verify`: a registry whose connections have real
 * manifests (senses, events, operations with effects), and a scripted
 * `Verifier` that records what core hands it. Core never imports
 * `@noetic-tools/verify`, so its tests use a double of the contract.
 */

import type {
  ArtifactStore,
  ConnectionEvent,
  ConnectionIdentity,
  ConnectionManifest,
  ConnectionOperationInfo,
  Context,
  EventStream,
  EventStreamMessage,
  SenseDescriptor,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import type {
  PreparedVerify,
  VerificationRun,
  Verifier,
  VerifyHost,
  VerifyOutput,
  VerifyParticipant,
  VerifySpec,
} from '@noetic-tools/types/verify';
import type {
  ConnectionRegistry,
  GatedCallOptions,
  ResolvedConnection,
  ResolveRequest,
} from '../../src/connections/registry-types';
import { AgentHarness } from '../../src/harness/agent-harness';

//#region Registry

export interface VerifyConnectionConfig {
  senses?: Record<string, SenseDescriptor>;
  operations?: Record<string, Partial<ConnectionOperationInfo>>;
  resources?: Record<string, unknown>;
  events?: string[];
  identity?: ConnectionIdentity;
  onCall?: (op: string, args: unknown) => unknown;
}

export interface RecordedVerifyCall {
  connection: string;
  op: string;
  args: unknown;
  opts: GatedCallOptions;
}

function emptyStream(): EventStream<ConnectionEvent> {
  let close: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return {
    ready: Promise.resolve({
      cursor: null,
    }),
    close: async () => close(),
    [Symbol.asyncIterator](): AsyncIterator<EventStreamMessage<ConnectionEvent>> {
      return {
        next: async () => {
          await closed;
          return {
            done: true,
            value: undefined,
          };
        },
      };
    },
  };
}

function manifestOf(config: VerifyConnectionConfig): ConnectionManifest {
  const operations: Record<string, ConnectionOperationInfo> = {};
  for (const [name, info] of Object.entries(config.operations ?? {})) {
    operations[name] = {
      name,
      inputSchema: {
        type: 'object',
      },
      ...info,
    };
  }
  return {
    profiles: {},
    extensions: {},
    operations,
    resources: Object.fromEntries(
      Object.keys(config.resources ?? {}).map((name) => [
        name,
        {
          name,
        },
      ]),
    ),
    events: Object.fromEntries(
      (config.events ?? []).map((name) => [
        name,
        {
          name,
          replay: 'live' as const,
        },
      ]),
    ),
    senses: config.senses ?? {},
  };
}

/** A registry of connections with manifests, recording resolves and calls. */
export class VerifyRegistry implements ConnectionRegistry {
  readonly resolves: ResolveRequest[] = [];
  readonly calls: RecordedVerifyCall[] = [];
  readonly reads: string[] = [];

  constructor(private readonly connections: Record<string, VerifyConnectionConfig>) {}

  names(): ReadonlyArray<string> {
    return Object.keys(this.connections);
  }

  async resolve(request: ResolveRequest): Promise<ResolvedConnection> {
    this.resolves.push(request);
    const config = this.connections[request.name];
    if (!config) {
      throw new NoeticConfigError({
        code: 'CONNECTION_UNKNOWN',
        message: `No connection '${request.name}'.`,
        hint: 'Add it to the test registry.',
      });
    }
    return this.resolvedFor(request.name, config);
  }

  async releaseScope(): Promise<void> {}
  async releaseRun(): Promise<void> {}

  status(): ReadonlyArray<never> {
    return [];
  }

  private resolvedFor(name: string, config: VerifyConnectionConfig): ResolvedConnection {
    return {
      name,
      manifest: manifestOf(config),
      identity: () =>
        config.identity ?? {
          surface: 'web',
          instance: `${name}-1`,
        },
      call: async (op, args, opts) => {
        this.calls.push({
          connection: name,
          op,
          args,
          opts,
        });
        return config.onCall?.(op, args) ?? null;
      },
      read: async (resource) => {
        this.reads.push(`${name}:${resource}`);
        const base = resource.split('?')[0] ?? resource;
        return config.resources?.[base] ?? null;
      },
      listen: () => emptyStream(),
    };
  }
}

//#endregion

//#region Verifier double

export interface ScriptedVerifier extends Verifier {
  readonly prepared: Array<{
    spec: VerifySpec;
    participants: ReadonlyArray<VerifyParticipant>;
  }>;
  readonly hosts: VerifyHost[];
}

/** A minimal OVP run document, valid in shape, for `host.record`. */
export function runDocument(id: string): VerificationRun {
  return {
    ovp: '1.0',
    id,
    verifier: {
      name: 'scripted',
      version: '0',
    },
    subject: {
      surface: 'web',
      instance: 'app-1',
    },
    channels: [],
    witnesses: [],
    intents: [],
    claims: [],
    constraints: [],
    actions: [],
    receipts: [],
    windows: [],
    evidence: [],
    coverage: [],
    anomalies: [],
    verdicts: [],
    violations: [],
    repairs: [],
    startedAt: 0,
    endedAt: 1,
  };
}

/**
 * A verifier that runs `act`, records a run, and answers `outcome`. `during`
 * runs between act and record, with the host, for tests that poke at it.
 */
export function scriptedVerifier(opts?: {
  outcome?: (spec: VerifySpec) => VerifyOutput['outcome'];
  during?: (host: VerifyHost) => Promise<void>;
}): ScriptedVerifier {
  const prepared: ScriptedVerifier['prepared'] = [];
  const hosts: VerifyHost[] = [];
  return {
    name: 'scripted',
    version: '0',
    prepared,
    hosts,
    prepare(spec, participants): PreparedVerify {
      prepared.push({
        spec,
        participants,
      });
      return {
        spec,
        claims: [],
        constraints: [],
        senses: {},
        events: {},
      };
    },
    async run(p, host): Promise<VerifyOutput> {
      hosts.push(host);
      await host.act();
      await opts?.during?.(host);
      const run = await host.record(runDocument(p.spec.id));
      return {
        outcome: opts?.outcome?.(p.spec) ?? 'pass',
        verdicts: [],
        violations: [],
        gaps: [],
        repairs: [],
        run,
      };
    },
  };
}

//#endregion

//#region Harness

/** A harness with a registry and (optionally) a verifier, the way the harness exposes them. */
export function verifyHarness(opts: {
  registry?: ConnectionRegistry;
  verifier?: Verifier;
  artifacts?: ArtifactStore;
}): AgentHarness {
  const harness = new AgentHarness({
    name: 'verify-test',
    params: {},
    verification: opts.verifier,
    environment: opts.artifacts
      ? {
          artifacts: opts.artifacts,
        }
      : undefined,
  });
  if (opts.registry) {
    frameworkCast<{
      connectionRegistry?: ConnectionRegistry;
    }>(harness).connectionRegistry = opts.registry;
  }
  return harness;
}

/** A root context of `harness`. */
export function contextOf(harness: AgentHarness): Context {
  return harness.createContext();
}

export const INDEPENDENT: SenseDescriptor = {
  independence: 'independent',
  grade: 'consequence',
};

/** The standard subject: net and ui senses, one effects op, one read-only op. */
export function appConfig(extra?: Partial<VerifyConnectionConfig>): VerifyConnectionConfig {
  return {
    senses: {
      net: INDEPENDENT,
    },
    operations: {
      'ui.tap': {
        effects: true,
      },
      'ui.find': {},
    },
    events: [
      'browser.request',
    ],
    ...extra,
  };
}

//#endregion
