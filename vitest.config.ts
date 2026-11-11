import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts is the process entrypoint; types.ts is types-only.
      exclude: ["src/server/index.ts", "src/server/types.ts"],
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
          exclude: [".claude/**", "dist/**", "node_modules/**"],
        },
      },
      {
        // React component tests: compiled browser-side, rendered into jsdom.
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
