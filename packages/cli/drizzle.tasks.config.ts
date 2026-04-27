import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/commands/builtins/tasks/db/schema.ts',
  out: './src/commands/builtins/tasks/db/migrations',
});
