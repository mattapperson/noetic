/**
 * A registry of ACP agent adapters keyed by `agentId`. Pass one to a JSON
 * workflow's `HydrationContext.acpAgents` so `acp-agent` nodes resolve their
 * `agent` key to a live adapter.
 */

import type { AcpAgent } from '@noetic-tools/types';

/** @public ACP agent adapters keyed by agent id. */
export type AcpAgentRegistry = Map<string, AcpAgent>;

/** @public Build an {@link AcpAgentRegistry} from a list of adapters. */
export function createAcpAgentRegistry(...agents: AcpAgent[]): AcpAgentRegistry {
  const registry: AcpAgentRegistry = new Map();
  for (const agent of agents) {
    registry.set(agent.agentId, agent);
  }
  return registry;
}
