/**
 * Cross-package check of the webhook receiver contract (specs 25 and 35):
 * `createWebhookReceiver()` from `@noetic-tools/platform-node` is the receiver
 * `mcp({ webhooks })` takes, and mcp's own Standard Webhooks verification runs
 * on the deliveries it hands through. The two packages never import each
 * other, so the assignment below is what keeps their shapes in step.
 *
 * Run: `bun run example:webhook`. Exits non-zero when a check fails.
 */

import assert from 'node:assert';
import type { McpWebhooks, WebhookReceiver } from '@noetic-tools/mcp';
import { generateWebhookSecret, signWebhook, verifyWebhook } from '@noetic-tools/mcp';
import { createWebhookReceiver } from '@noetic-tools/platform-node';

const nodeReceiver = createWebhookReceiver();
// Compile-time: the Node receiver satisfies the contract mcp() consumes.
const receiver: WebhookReceiver = nodeReceiver;
const webhooks: McpWebhooks = {
  receiver,
};

const secret = generateWebhookSecret();
const delivered: string[] = [];
const seen = new Set<string>();
const endpoint = await webhooks.receiver.register(async (delivery) => {
  const verification = await verifyWebhook({
    secret,
    delivery,
    nowSec: Math.floor(Date.now() / 1e3),
    seen,
  });
  if (!verification.ok) {
    return {
      status: 401,
    };
  }
  delivered.push(delivery.body);
  return {
    status: 204,
  };
});

async function post(body: string, signingSecret: string, id: string): Promise<number> {
  const headers = await signWebhook({
    secret: signingSecret,
    id,
    timestampSec: Math.floor(Date.now() / 1e3),
    body,
  });
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers,
    body,
  });
  return response.status;
}

try {
  const event = JSON.stringify({
    type: 'deploy.failed',
    payload: {
      service: 'api',
    },
  });
  assert.equal(await post(event, secret, 'msg_1'), 204);
  assert.equal(await post(event, generateWebhookSecret(), 'msg_2'), 401);
  assert.deepEqual(delivered, [
    event,
  ]);
  console.log('webhook-e2e: ok');
} finally {
  await endpoint.close();
  await nodeReceiver.close();
}
