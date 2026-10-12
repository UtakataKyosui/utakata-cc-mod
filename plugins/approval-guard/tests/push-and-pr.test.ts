import type { On } from "claude-code";
import { test, expect } from "claude-code/testing";

import { bodyFileOf, isForcePush, mentionsIssue } from "../hooks/push-and-pr";

const BASH = "Bash";

function bashSucceeds(on: On) {
  on("tool.call", { tool: BASH }, () => ({
    result: { stdout: "ok", stderr: "" },
  }));
}

test("force push のフラグを見分ける", () => {
  expect(isForcePush("git push --force origin main")).toBe(true);
  expect(isForcePush("git push -f")).toBe(true);
  expect(isForcePush("git push --force-with-lease")).toBe(true);
  expect(isForcePush("git push origin main")).toBe(false);
});

test("force push の判定は元のシェルと同じく行をまたがない", () => {
  expect(isForcePush("git push x\n-f")).toBe(false);
  expect(isForcePush("git\npush --force")).toBe(false);
  expect(isForcePush("echo start\ngit push --force origin x")).toBe(true);
});

test("Closes キーワードと Issue 対応でない旨の注記を行単位で見分ける", () => {
  expect(mentionsIssue("Closes #84")).toBe(true);
  expect(mentionsIssue("fixes #1")).toBe(true);
  expect(mentionsIssue("この PR は Issue 対応ではない")).toBe(true);
  expect(mentionsIssue("not an issue")).toBe(true);
  expect(mentionsIssue("see #84")).toBe(false);
  expect(mentionsIssue("Closes\n#84")).toBe(false);
});

test("--body-file の引数を取り出す", () => {
  expect(bodyFileOf("gh pr create --body-file body.md")).toBe("body.md");
  expect(bodyFileOf("gh pr create --body-file")).toBe("");
  expect(bodyFileOf("gh pr create --body x")).toBe(undefined);
});

test("Closes キーワードの無い PR 作成は拒否される", async ($, on) => {
  bashSucceeds(on);
  const r = await $.tool.call({
    tool: BASH,
    command: 'gh pr create --title t --body "説明だけ"',
  });
  expect(r.deny).toContain("Issue close キーワードがありません");
});

test("Closes キーワードか Issue 対応でない旨があれば PR 作成は通る", async ($, on) => {
  bashSucceeds(on);
  const a = await $.tool.call({
    tool: BASH,
    command: 'gh pr create --title t --body "Closes #12"',
  });
  expect(a.deny).toBe(undefined);
  const b = await $.tool.call({
    tool: BASH,
    command: 'gh pr create --title t --body "no issue"',
  });
  expect(b.deny).toBe(undefined);
});

test("読めない --body-file は誤検出を避けて通す", async ($, on) => {
  bashSucceeds(on);
  on("fs.read", () => {
    throw new Error("ENOENT");
  });
  const r = await $.tool.call({
    tool: BASH,
    command: "gh pr create --title t --body-file /nonexistent/body.md",
  });
  expect(r.deny).toBe(undefined);
});
