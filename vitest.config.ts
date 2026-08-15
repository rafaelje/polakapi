import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    css: false,
    maxWorkers: process.platform === "win32" ? 4 : undefined,
  },
});
