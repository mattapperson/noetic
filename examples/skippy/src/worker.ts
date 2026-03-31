import { getInitializedBot } from './bot';
import type { Env } from './env';
import { DISCORD_WEBHOOK_PATH } from './env';
import { GATEWAY_DO_ID, GatewayDurable } from './gateway-durable';

export { GatewayDurable };

//#region Helpers

function getGatewayStub(env: Env): DurableObjectStub {
  const id = env.GATEWAY_DURABLE.idFromName(GATEWAY_DO_ID);
  return env.GATEWAY_DURABLE.get(id);
}

//#endregion

//#region Route Handlers

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const bot = await getInitializedBot(env);
  return bot.webhooks.discord(request, {
    waitUntil: (p) => ctx.waitUntil(p),
  });
}

function handleGatewayStart(env: Env): Promise<Response> {
  return getGatewayStub(env).fetch(
    new Request('https://do/start', {
      method: 'POST',
    }),
  );
}

function handleGatewayStatus(env: Env): Promise<Response> {
  return getGatewayStub(env).fetch(new Request('https://do/status'));
}

//#endregion

//#region Worker Export

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === DISCORD_WEBHOOK_PATH) {
      return handleWebhook(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/gateway/start') {
      return handleGatewayStart(env);
    }

    if (request.method === 'GET' && url.pathname === '/gateway/status') {
      return handleGatewayStatus(env);
    }

    return new Response('Not Found', {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;

//#endregion
