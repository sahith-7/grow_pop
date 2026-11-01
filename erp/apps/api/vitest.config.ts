import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    env: { NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' },
    fileParallelism: false,
    testTimeout: 20000,
  },
});
