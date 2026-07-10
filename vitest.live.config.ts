import { defineConfig } from "vitest/config";

// Live-suite entrypoint: `npx vitest run --config vitest.live.config.ts`.
// Tests self-skip unless AUT_INKBOX_API_KEY + REMOTE_INKBOX_API_KEY are set.
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
  },
});
