import { getInitializedBot } from './bot';
import type { Env } from './env';
import { DISCORD_WEBHOOK_PATH } from './env';

export const GATEWAY_DO_ID = 'singleton';

const ALARM_INTERVAL_MS = 5 * 60 * 1e3;
const GATEWAY_DURATION_MS = 10 * 60 * 1e3;

//#region Durable Object

export class GatewayDurable implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/start') {
      await this.startGateway();
      return Response.json({
        status: 'started',
      });
    }

    if (url.pathname === '/status') {
      const alarm = await this.state.storage.getAlarm();
      return Response.json({
        active: alarm !== null,
      });
    }

    return new Response('Not Found', {
      status: 404,
    });
  }

  async alarm(): Promise<void> {
    await this.startGateway();
  }

  private async startGateway(): Promise<void> {
    const bot = await getInitializedBot(this.env);
    const webhookUrl = `${this.env.WORKER_URL}${DISCORD_WEBHOOK_PATH}`;
    const discord = bot.getAdapter('discord');

    try {
      await discord.startGatewayListener(
        {
          waitUntil: (p) => this.state.waitUntil(p),
        },
        GATEWAY_DURATION_MS,
        undefined,
        webhookUrl,
      );
    } catch (err: unknown) {
      console.error('Gateway start failed:', err);
    } finally {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }
}

//#endregion
