import { test, expect } from "claude-code/testing";

import { bareRunnerHint } from "../hooks/mise-exec";

test("bare pnpm is flagged", () => {
  expect(bareRunnerHint("pnpm turbo build")).toContain("mise exec 推奨");
});

test("bare node is flagged", () => {
  expect(bareRunnerHint("node scripts/generate.js")).toContain(
    "mise exec 推奨",
  );
});

test("bare npx is flagged", () => {
  expect(bareRunnerHint("npx tsc --noEmit")).toContain("mise exec 推奨");
});

test("already using mise exec -- is not flagged", () => {
  expect(bareRunnerHint("mise exec -- pnpm turbo build")).toBeNull();
  expect(bareRunnerHint("cd app && mise exec -- pnpm test")).toBeNull();
});

test("each line is checked on its own", () => {
  expect(bareRunnerHint("echo start\npnpm install")).toContain(
    "mise exec 推奨",
  );
});

test("pnpm inside a quoted string is not flagged", () => {
  expect(
    bareRunnerHint('gh pr comment -b "run pnpm install locally"'),
  ).toBeNull();
});

test("pnpm after && is still flagged", () => {
  expect(bareRunnerHint("git pull && pnpm install")).toContain(
    "mise exec 推奨",
  );
});

test("hints are capped at 3", () => {
  const hint = bareRunnerHint("pnpm build; node run.js; npx tsc");
  expect(hint).not.toBeNull();
  expect((hint ?? "").split("\n").length).toBeLessThanOrEqual(3);
});

test("unrelated command is silent", () => {
  expect(bareRunnerHint("git status")).toBeNull();
});
