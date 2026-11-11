// React component tests (vitest "react" project). Testing Library unmounts
// what a test rendered only when the runner exposes a global `afterEach`;
// vitest runs without globals here, so the cleanup is registered by hand.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
