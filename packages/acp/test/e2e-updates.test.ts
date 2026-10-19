import { expect, test } from 'bun:test';
import { RequestError } from '@agentclientprotocol/sdk';
import { AgentHarness, step } from '@noetic-tools/core';
import { defineAcpAgent } from '../src/define';
import { loopbackTransport } from '../src/transport-loopback';

test.each([
  'new',
  'prompt',
])('keeps authentication errors readable during session/%s', async (phase) => {
  const agent = defineAcpAgent({
    agentId: 'authentication-test',
    transport: loopbackTransport(() => ({
      async initialize(params) {
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: {},
          authMethods: [],
        };
      },
      async authenticate() {
        return {};
      },
      async newSession() {
        if (phase === 'new') {
          throw RequestError.authRequired();
        }
        return {
          sessionId: 'test',
        };
      },
      async prompt() {
        throw RequestError.authRequired();
      },
      async cancel() {},
    })),
  });
  const harness = new AgentHarness({
    name: 'test',
    params: {},
  });
  const task = step.acpAgent({
    id: `auth-${phase}`,
    agent,
    prompt: 'go',
  });
  await expect(harness.run(task, undefined, harness.createContext())).rejects.toThrow(
    'Authentication required',
  );
});

test('keeps nested JSON-RPC error details in the step failure', async () => {
  const agent = defineAcpAgent({
    agentId: 'error-test',
    transport: loopbackTransport(() => ({
      async initialize(params) {
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: {},
          authMethods: [],
        };
      },
      async authenticate() {
        return {};
      },
      async newSession() {
        return {
          sessionId: 'test',
        };
      },
      async prompt() {
        throw RequestError.internalError({
          message: 'This model requires a newer version of Codex',
        });
      },
      async cancel() {},
    })),
  });
  const harness = new AgentHarness({
    name: 'test',
    params: {},
  });
  const task = step.acpAgent({
    id: 'nested-error',
    agent,
    prompt: 'go',
  });
  await expect(harness.run(task, undefined, harness.createContext())).rejects.toThrow(
    'This model requires a newer version of Codex',
  );
});
