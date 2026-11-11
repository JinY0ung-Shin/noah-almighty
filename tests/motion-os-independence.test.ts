import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Kept out of `client-motion.test.ts`: that file is type-checked with the client
// tsconfig, which has no node types. The behaviour itself is tested there.
describe("the client never reads the OS motion setting", () => {
  // A media query on `prefers-reduced-motion` — CSS `@media (…)` or JS
  // `matchMedia("(…)")` — ties the app's motion to the operating system again.
  // CSS keys on `:root[data-motion="reduce"]`, JS on `prefersReducedMotion()`.
  const QUERY = /\(\s*prefers-reduced-motion/;
  const ROOTS = ["src/client/src", "src/client/styles"];

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(css|svelte|tsx?)$/.test(entry.name) ? [path] : [];
    });
  }

  it("has no prefers-reduced-motion media query in any stylesheet, component or module", () => {
    const files = ROOTS.flatMap(sources);
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((file) => QUERY.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});
