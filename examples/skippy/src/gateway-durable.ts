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
  private running = false;

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
    if (this.running) {
      return;
    }

    this.running = true;
    const bot = await getInitializedBot(this.env);
    const webhookUrl = `${this.env.WORKER_URL}${DISCORD_WEBHOOK_PATH}`;
    const discord = bot.getAdapter('discord');

    try {
      // startGatewayListener returns immediately after enqueuing the
      // WebSocket session via waitUntil. We schedule the next alarm for
      // after GATEWAY_DURATION_MS so it doesn't overlap the running session,
      // and clear the running flag on a timer matching the session lifetime.
      await discord.startGatewayListener(
        {
          waitUntil: (p) => this.state.waitUntil(p),
        },
        GATEWAY_DURATION_MS,
        undefined,
        webhookUrl,
      );
      await this.state.storage.setAlarm(Date.now() + GATEWAY_DURATION_MS + ALARM_INTERVAL_MS);
      setTimeout(() => {
        this.running = false;
      }, GATEWAY_DURATION_MS);
    } catch (err: unknown) {
      console.error('Gateway start failed:', err);
      this.running = false;
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }
}

//#endregion
