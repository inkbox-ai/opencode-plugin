import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The live suite talks to real Inkbox identities; it runs only via
    // vitest.live.config.ts (CI live workflows or explicit local runs).
    exclude: ["**/node_modules/**", "tests/live/**"],
  },
});
