export const DISCORD_WEBHOOK_PATH = '/webhooks/discord';

export interface Env {
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  OPENROUTER_API_KEY: string;
  WORKER_URL: string;
  GATEWAY_DURABLE: DurableObjectNamespace;
}
