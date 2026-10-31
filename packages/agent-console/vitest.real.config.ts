import { defineConfig } from "vitest/config";

// npm run test:real — the real agent CLIs against a local fake model API (see test/real/agents-images.real.test.ts)
export default defineConfig({
  test: {
    include: ["test/real/**/*.real.test.ts"],
    testTimeout: 240000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
