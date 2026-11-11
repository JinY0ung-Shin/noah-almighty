import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts/main.ts are process/browser entrypoints; types.ts is types-only.
      exclude: ["src/server/index.ts", "src/server/types.ts", "src/client/src/main.ts"],
      reporter: ["text", "text-summary"],
      // Regression floor, a hair under the achieved coverage (2026-08: ~94/86/95/93).
      // Raise as coverage grows; don't lower to admit untested code.
      thresholds: { lines: 93, branches: 84, functions: 93, statements: 91 },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [".claude/**", "dist/**", "node_modules/**", "tests/svelte-*.test.ts"],
        },
      },
      {
        // Svelte component tests: compiled browser-side, rendered into jsdom.
        plugins: [svelte(), svelteTesting()],
        test: {
          name: "components",
          include: ["tests/svelte-*.test.ts"],
          environment: "jsdom",
          setupFiles: ["tests/setup-dom.ts"],
        },
      },
      {
        // React component tests (the client is moving from Svelte to React; a
        // ported component's tests move from tests/svelte-*.test.ts to
        // tests/react-*.test.tsx with it).
        plugins: [react({ include: /\.tsx$/ })],
        test: {
          name: "react",
          include: ["tests/react-*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["tests/setup-dom.ts", "tests/setup-react.ts"],
        },
      },
    ],
  },
});
