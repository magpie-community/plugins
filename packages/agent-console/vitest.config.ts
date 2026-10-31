import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/v1/**/*.test.ts", "web/src/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
