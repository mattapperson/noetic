export default {
  retries: 1,
  timeout: 60000,
  shellReadyTimeout: 10000,
  testMatch: 'test/e2e/**/*.test.ts',
  use: {
    rows: 30,
    columns: 100,
  },
};
