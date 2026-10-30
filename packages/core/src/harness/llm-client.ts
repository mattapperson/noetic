import type { ItemSchemaRegistry, NoeticConfigError } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { callDecide } from './decide-call';
import { HTTPClient, OpenRouter, OpenRouterSdk } from './deps/adapters';
import { someStep } from './deps/interpreter';
import type {
  AgentHarnessContract,
  CallModelRequest,
  ContextCacheConfig,
  ContextData,
  DecideRequest,
  DecideResponse,
  LLMResponse,
  LlmProviderConfig,
  Step,
  TraceExporter,
} from './deps/types';
import { AgentHarnessModelCaller, noLlmProviderError } from './model-call';
import type { Spend } from './spend';
import { DISPATCH_HEADER, GENERATION_HEADER } from './spend';

//#region Types

/** Env vars consulted when resolving the LLM client (read defensively so the
 *  harness also works in runtimes without a `process` global, e.g. the browser). */
export interface LlmEnv {
  noeticApiKey?: string;
  noeticBaseUrl?: string;
  openrouterApiKey?: string;
}

/** @public Effective client options resolved from config + environment. */
export interface ResolvedLlmClient {
  apiKey: string;
  /** Undefined means "use the SDK's default OpenRouter base URL". */
  serverURL?: string;
  cache: boolean;
}

type ClientOptions = NonNullable<ConstructorParameters<typeof OpenRouter>[0]>;

/** What the harness's model gateway is built from. */
export interface LlmGatewayOptions {
  agentName: string;
  providerConfig?: LlmProviderConfig;
  contextCache?: ContextCacheConfig;
  /** Paid dispatch records; when present, both clients note each call's generation id. */
  spend?: Spend;
  callModelOverride?: (request: CallModelRequest) => Promise<LLMResponse>;
  decideOverride?: (request: DecideRequest) => Promise<DecideResponse>;
  streamIdleTimeoutMs: number;
}

/** The per-call parts of a model call the harness supplies. */
export interface ModelCallHost {
  itemSchemas: ItemSchemaRegistry;
  harness: AgentHarnessContract;
  traceExporter: TraceExporter;
}

//#endregion

//#region Client resolution

/** The Noetic platform's OpenAI-Responses-compatible inference base URL. */
const NOETIC_DEFAULT_BASE_URL = 'https://platform.noetic.tools/v1';

function readLlmEnv(): LlmEnv {
  const processValue = 'process' in globalThis ? globalThis.process : undefined;
  const env =
    typeof processValue === 'object' && processValue !== null && 'env' in processValue
      ? processValue.env
      : undefined;
  if (typeof env !== 'object' || env === null) {
    return {};
  }
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  return {
    noeticApiKey: 'NOETIC_API_KEY' in env ? str(env.NOETIC_API_KEY) : undefined,
    noeticBaseUrl: 'NOETIC_BASE_URL' in env ? str(env.NOETIC_BASE_URL) : undefined,
    openrouterApiKey: 'OPENROUTER_API_KEY' in env ? str(env.OPENROUTER_API_KEY) : undefined,
  };
}

/**
 * Resolve the effective LLM client options from the provider config + environment.
 * Defaults to the Noetic platform (`provider: 'noetic'`): the `'noetic'` provider
 * authenticates with `NOETIC_API_KEY` and targets the Noetic platform base URL,
 * while `'openrouter'` authenticates with `OPENROUTER_API_KEY` and uses the SDK's
 * default OpenRouter endpoint. Returns undefined when no API key is available.
 * Exported for testing.
 */
export function resolveLlmClient(
  config: LlmProviderConfig | undefined,
  env: LlmEnv,
): ResolvedLlmClient | undefined {
  const provider = config?.provider ?? 'noetic';
  const apiKey =
    config?.apiKey ?? (provider === 'noetic' ? env.noeticApiKey : env.openrouterApiKey);
  if (!apiKey) {
    return undefined;
  }
  const serverURL =
    provider === 'noetic'
      ? (config?.baseUrl ?? env.noeticBaseUrl ?? NOETIC_DEFAULT_BASE_URL)
      : config?.baseUrl;
  return {
    apiKey,
    serverURL,
    cache: config?.cache ?? false,
  };
}

/**
 * Ask the provider to cache the prompt prefix.
 *
 * Anthropic caching is opt-in — without a breakpoint it caches nothing however
 * stable the prefix is, measured against live models. OpenRouter accepts a
 * `cache_control` directive on the request and places the breakpoints itself;
 * providers that cache on their own (OpenAI, Gemini) ignore it.
 *
 * It has to be injected here rather than passed with the other request fields:
 * the SDK validates the request against a generated schema that drops keys it
 * does not know, and `cache_control` is one of them.
 */
async function addCacheBreakpoint(request: Request): Promise<Request> {
  const body = await request.clone().text();
  if (!body) {
    return request;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return request;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return request;
  }
  return new Request(request, {
    body: JSON.stringify({
      ...payload,
      cache_control: {
        type: 'ephemeral',
      },
    }),
  });
}

function createClient(
  config?: LlmProviderConfig,
  contextCache?: ContextCacheConfig,
  http?: HTTPClient,
): OpenRouter | undefined {
  const resolved = resolveLlmClient(config, readLlmEnv());
  if (!resolved) {
    return undefined;
  }
  const options: {
    apiKey: string;
    serverURL?: string;
    httpClient?: ClientOptions['httpClient'];
  } = {
    apiKey: resolved.apiKey,
  };
  if (resolved.serverURL) {
    options.serverURL = resolved.serverURL;
  }
  if (http) {
    // The agent bundles an older SDK whose `HTTPClient` class is nominally different;
    // the agent calls only `request()` on it, which both versions share.
    options.httpClient = frameworkCast<ClientOptions['httpClient']>(http);
  }

  // A cache write costs more than a plain read, so the breakpoint only pays off
  // when something is holding the prefix still — which is what anchoring does.
  const wantsBreakpoint = contextCache?.enabled !== false;
  if (!resolved.cache && !wantsBreakpoint) {
    return new OpenRouter(options);
  }
  return new OpenRouter({
    ...options,
    hooks: {
      beforeRequest: async (_ctx, request) => {
        if (resolved.cache) {
          // Serve identical model calls from OpenRouter's own response cache
          // without re-billing (deterministic re-runs).
          request.headers.set('X-OpenRouter-Cache', 'true');
        }
        return wantsBreakpoint ? addCacheBreakpoint(request) : request;
      },
    },
  });
}

/**
 * An HTTP client that saves a paid call's generation id the moment its headers
 * arrive. The SDK awaits the hook before it reads the body, so a call cut off after
 * its headers can still be priced. Both the model client and the decisions client
 * send through it; requests without a dispatch header pass untouched.
 */
function generationHook(spend: Spend): HTTPClient {
  return new HTTPClient().addHook('response', async (res, req) => {
    const dispatchId = req.headers.get(DISPATCH_HEADER);
    const generationId = res.headers.get(GENERATION_HEADER);
    // An error response is retried or refused; only a success carries the call's id.
    if (res.ok && dispatchId && generationId) {
      await spend.noteGeneration(dispatchId, generationId);
    }
  });
}

function createSdkClient(config?: LlmProviderConfig, http?: HTTPClient): OpenRouterSdk | undefined {
  const resolved = resolveLlmClient(config, readLlmEnv());
  if (!resolved) {
    return undefined;
  }
  return new OpenRouterSdk({
    apiKey: resolved.apiKey,
    serverURL: resolved.serverURL,
    ...(http
      ? {
          httpClient: http,
        }
      : {}),
  });
}

//#endregion

//#region LlmGateway

/**
 * The harness's route to its model provider: the provider clients resolved from
 * config + environment, the test overrides, and the `callModel` / `decide` calls
 * made through them.
 */
export class LlmGateway {
  readonly #options: LlmGatewayOptions;
  private readonly client?: OpenRouter;
  /**
   * SDK 1.x client for the endpoints the agent's client predates: decisions, model
   * prices, and generation lookups.
   */
  readonly sdkClient?: OpenRouterSdk;
  /** Model id → whether it answers natively as a decision model. */
  private readonly decisionModels = new Map<string, Promise<boolean>>();

  constructor(options: LlmGatewayOptions) {
    this.#options = options;
    const http = options.spend ? generationHook(options.spend) : undefined;
    this.client = options.callModelOverride
      ? undefined
      : createClient(options.providerConfig, options.contextCache, http);
    this.sdkClient = options.callModelOverride
      ? undefined
      : createSdkClient(options.providerConfig, http);
  }

  callModel(request: CallModelRequest, host: ModelCallHost): Promise<LLMResponse> {
    return new AgentHarnessModelCaller({
      agentName: this.#options.agentName,
      itemSchemas: host.itemSchemas,
      client: this.client,
      callModelOverride: this.#options.callModelOverride,
      streamIdleTimeoutMs: this.#options.streamIdleTimeoutMs,
      harness: host.harness,
      traceExporter: host.traceExporter,
      spend: this.#options.spend,
    }).callModel(request);
  }

  decide(
    request: DecideRequest,
    callModel: (request: CallModelRequest) => Promise<LLMResponse>,
  ): Promise<DecideResponse> {
    if (this.#options.decideOverride) {
      return this.#options.decideOverride(request);
    }
    return callDecide(request, {
      client: this.sdkClient,
      callModel,
      nativeModels: this.decisionModels,
      spend: this.#options.spend,
    });
  }

  /**
   * The error to fail with when `step` calls a model this harness has no
   * credentials for, else undefined. Checked before any step runs so a missing
   * provider fails fast instead of after earlier steps' side effects. Steps the
   * walk cannot see (dynamic branches) still hit the same error lazily at their
   * model call.
   */
  missingModelFor<I, O>(step: Step<ContextData, I, O>): NoeticConfigError | undefined {
    if (this.client || this.#options.callModelOverride) {
      return undefined;
    }
    const decideOverride = this.#options.decideOverride;
    const needsModel = someStep(
      frameworkCast<Step>(step),
      (s) => s.kind === 'callModel' || (s.kind === 'decide' && !decideOverride),
    );
    return needsModel ? noLlmProviderError() : undefined;
  }
}

//#endregion
