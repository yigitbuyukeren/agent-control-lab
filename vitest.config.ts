import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['{apps,packages}/**/*.test.ts'], testTimeout: 20_000 },
});
