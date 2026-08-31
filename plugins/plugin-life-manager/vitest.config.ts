import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["eliza-source"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Several files spawn real child processes — a bun worker booting PGlite,
    // an execFile'd provider tool. Run in parallel they contend for CPU and
    // one of them intermittently misses its window, which reads as a failure
    // in code that did not change.
    fileParallelism: false,
  },
});
