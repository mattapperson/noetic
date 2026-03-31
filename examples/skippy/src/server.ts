import { bot } from './bot';

const PORT = Number(process.env.PORT) || 3e3;
const WEBHOOK_URL = `http://localhost:${PORT}/webhooks/discord`;
const GATEWAY_DURATION_MS = 10 * 60 * 1e3;

const waitUntilOpts = {
  waitUntil: (task: Promise<unknown>): void => void task.catch(console.error),
};

//#region Gateway Helper

async function startGateway(): Promise<void> {
  const discord = bot.getAdapter('discord');
  await discord.startGatewayListener(waitUntilOpts, GATEWAY_DURATION_MS, undefined, WEBHOOK_URL);
}

//#endregion

//#region HTTP Server

Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhooks/discord') {
      return bot.webhooks.discord(request, waitUntilOpts);
    }

    if (request.method === 'GET' && url.pathname === '/gateway') {
      await startGateway();
      return new Response('Gateway listener started');
    }

    return new Response('Not Found', {
      status: 404,
    });
  },
});

//#endregion

//#region Startup

await bot.initialize();
console.log(`Skippy is running on http://localhost:${PORT}`);

startGateway()
  .then(() => console.log('Gateway listener connected'))
  .catch((err: unknown) => console.error('Gateway listener failed:', err));

//#endregion
