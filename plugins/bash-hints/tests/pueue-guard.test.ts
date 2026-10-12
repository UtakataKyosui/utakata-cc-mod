import { test, expect } from "claude-code/testing";

import { pueueCommandDetected } from "../hooks/pueue-guard";

test("pueue at the start of the command is detected", () => {
  expect(pueueCommandDetected("pueue status")).toBe(true);
});

test("pueue after && is detected", () => {
  expect(pueueCommandDetected("cd repo && pueue add -- npm test")).toBe(true);
});

test("pueue after ; is detected", () => {
  expect(pueueCommandDetected("echo start; pueue status")).toBe(true);
});

test("pueued (the daemon binary itself) is not detected", () => {
  expect(pueueCommandDetected("pueued -d")).toBe(false);
});

test("unrelated command is not detected", () => {
  expect(pueueCommandDetected("git status")).toBe(false);
});
