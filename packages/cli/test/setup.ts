import { beforeEach } from 'bun:test';

beforeEach(() => {
  process.env.OPENROUTER_API_KEY ??= 'test-key';
});
