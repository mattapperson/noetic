/**
 * What a step hands an ACP agent at launch: the process environment, and the
 * auth method to run once `initialize` has told us which ones the agent offers.
 *
 * ACP's `authenticate` carries only a method id, never a credential, so an API
 * key reaches the agent through the variable its adapter names in
 * `AcpAgent.apiKey`. Both settings apply only when a connection opens, which
 * is why they travel together and are compared together on reuse.
 */

import type {
  AcpAgent,
  AcpAgentConnection,
  AcpAuthMethod,
  Context,
  StepAcpAgent,
} from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { resolveLazy } from './execute-action';

//#region Types

/** A step's resolved launch settings. */
export interface AcpLaunch {
  env?: Record<string, string | undefined>;
  methodId?: string;
  /** `env` and `methodId` as one string, for comparing against a live session. */
  fingerprint: string;
  /** False when the step set neither `env` nor `auth`, so it accepts any live session. */
  requested: boolean;
}

//#endregion

//#region Public API

/**
 * Resolve the step's `env` and `auth` into launch settings, placing an API key
 * in the variable the agent reads it from.
 *
 * @throws `NoeticConfigError` `ACP_API_KEY_UNSUPPORTED` when the step passes a
 *   key but the adapter names no variable for one.
 */
export async function resolveLaunch<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  agent: AcpAgent,
  ctx: Context<TContext>,
): Promise<AcpLaunch> {
  const env = await resolveLazy(step.env, ctx);
  const auth = await resolveLazy(step.auth, ctx);
  const apiKey = auth?.apiKey;
  if (apiKey !== undefined && !agent.apiKey) {
    throw new NoeticConfigError({
      code: 'ACP_API_KEY_UNSUPPORTED',
      message: `step.acpAgent(${JSON.stringify(step.id)}) passes auth.apiKey, but the '${agent.agentId}' agent does not say where it reads an API key.`,
      hint: "Set the agent's own variable through `env` instead, or declare it on the adapter, e.g. customAcpAgent({ ..., apiKey: { env: 'MY_AGENT_API_KEY' } }).",
    });
  }
  const keyed =
    apiKey !== undefined && agent.apiKey
      ? {
          ...env,
          [agent.apiKey.env]: apiKey,
        }
      : env;
  const methodId = auth?.methodId ?? (apiKey !== undefined ? agent.apiKey?.methodId : undefined);
  return {
    env: keyed,
    methodId,
    fingerprint: fingerprintOf(keyed, methodId),
    requested: env !== undefined || auth !== undefined,
  };
}

/**
 * Run the launch's auth method on a freshly opened connection.
 *
 * The method must be one the agent advertised, and not a terminal method: the
 * protocol forbids passing those to `authenticate`, since they run the agent's
 * own login UI in a separate process.
 *
 * @throws `NoeticConfigError` `ACP_AUTH_METHOD_UNKNOWN` or
 *   `ACP_AUTH_METHOD_TERMINAL`, before anything reaches the wire.
 */
export async function authenticate(
  connection: AcpAgentConnection,
  launch: AcpLaunch,
  opts: {
    stepId: string;
    agentId: string;
  },
): Promise<void> {
  if (launch.methodId === undefined) {
    return;
  }
  const method = connection.authMethods.find((offered) => offered.id === launch.methodId);
  if (!method) {
    const offered = connection.authMethods.map((m) => m.id);
    throw new NoeticConfigError({
      code: 'ACP_AUTH_METHOD_UNKNOWN',
      message: `step.acpAgent(${JSON.stringify(opts.stepId)}) asks for auth method '${launch.methodId}', which the '${opts.agentId}' agent does not offer.`,
      hint:
        offered.length > 0
          ? `Use one of: ${offered.join(', ')}.`
          : 'The agent advertises no auth methods; drop `auth.methodId` and pass credentials through `env`.',
    });
  }
  if (isTerminalMethod(method)) {
    throw new NoeticConfigError({
      code: 'ACP_AUTH_METHOD_TERMINAL',
      message: `step.acpAgent(${JSON.stringify(opts.stepId)}) asks for auth method '${method.id}', a terminal login the agent runs itself.`,
      hint: "Sign in with the agent's own CLI first, or pass an API key with `auth.apiKey`.",
    });
  }
  await connection.authenticate(method.id);
}

//#endregion

//#region Helpers

function isTerminalMethod(method: AcpAuthMethod): boolean {
  return 'type' in method && method.type === 'terminal';
}

/** Key order is not a difference, so entries are sorted before comparison. */
function fingerprintOf(
  env: Record<string, string | undefined> | undefined,
  methodId?: string,
): string {
  const entries = Object.entries(env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    env: entries,
    methodId: methodId ?? null,
  });
}

//#endregion
