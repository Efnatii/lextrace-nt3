import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.js"],
    setupFiles: ["tests/unit/setup-indexeddb.js"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/shared/**/*.js", "src/content/dom-*.js"]
    }
  }
});