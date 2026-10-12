import { expect, test } from "claude-code/testing";

import {
  ancestorsOf,
  currentJjWorkspace,
  isInClaudeWorktree,
  isMainClaude,
  lsofCwd,
  parsePs,
  selfPsPid,
  SHARED_WORKTREE_MESSAGE,
  vcsMessage,
} from "../hooks/worktree-guard";

test("the own ps is found by the pid echoed before exec, not by its command line", () => {
  // 別セッション（pid 400 の claude）が同時に同じ ps を走らせ、その行が先に出た場合
  const stdout = `310
  PID  PPID ARGS
    1     0 /sbin/launchd
  200     1 claude --resume
  400     1 claude
  300   400 ps -eo pid,ppid,args
  310   200 ps -eo pid,ppid,args
`;
  const rows = parsePs(stdout);
  const self = rows.find((row) => row.pid === selfPsPid(stdout));
  const ancestors = ancestorsOf(rows, self?.ppid ?? 0);
  expect([...ancestors]).toEqual([200]);
  const others = rows.filter(
    (row) => !ancestors.has(row.pid) && isMainClaude(row.args),
  );
  expect(others.map((row) => row.pid)).toEqual([400]);
  expect(selfPsPid("  PID  PPID ARGS\n")).toBeNull();
});

test("the worktree check treats . as any character, as the shell grep does", () => {
  expect(isInClaudeWorktree("/repo/.claude/worktrees/feature")).toBe(true);
  expect(isInClaudeWorktree("/repo/xclaude/worktrees/feature")).toBe(true);
  expect(isInClaudeWorktree("/repo/claude/worktrees/feature")).toBe(false);
});

const PS = `  PID  PPID ARGS
    1     0 /sbin/launchd
  100     1 -zsh
  200   100 claude --resume
  300   200 ps -eo pid,ppid,args
  400     1 /Users/me/.local/bin/claude
  500   400 node /x/mcp-server.js
  600     1 claude-code-helper
`;

test("ps output is parsed and the own session is excluded through its ancestors", () => {
  const rows = parsePs(PS);
  expect(rows.map((row) => row.pid)).toEqual([1, 100, 200, 300, 400, 500, 600]);
  const self = rows.find((row) => row.args.startsWith("ps -eo"));
  const ancestors = ancestorsOf(rows, self?.ppid ?? 0);
  expect([...ancestors].sort()).toEqual([100, 200]);
  const others = rows.filter(
    (row) => !ancestors.has(row.pid) && isMainClaude(row.args),
  );
  expect(others.map((row) => row.pid)).toEqual([400]);
});

test("only main claude processes count", () => {
  expect(isMainClaude("claude")).toBe(true);
  expect(isMainClaude("/usr/local/bin/claude -p x")).toBe(true);
  expect(isMainClaude("claude-code-helper")).toBe(false);
  expect(isMainClaude("node /x/claude/server.js")).toBe(false);
  expect(isMainClaude("node /x/bin/claude --resume")).toBe(true);
  expect(isMainClaude("python3 x.py")).toBe(false);
});

test("jj workspace without a (current) marker is treated as default", () => {
  expect(
    currentJjWorkspace("default: ../../.claude qkq\nissue-84: . ypu\n"),
  ).toBe("default:");
  expect(currentJjWorkspace("default: a\nissue-84: b (current)\n")).toBe(
    "issue-84:",
  );
});

test("lsof cwd and vcs message follow the shell hook", () => {
  expect(lsofCwd("p400\nfcwd\nn/Users/me/repo\n")).toBe("/Users/me/repo");
  expect(vcsMessage(true, true)).toContain("jj リポジトリ");
  expect(vcsMessage(false, true)).toContain("Git リポジトリ");
  expect(vcsMessage(false, false)).toContain("手動でディレクトリを分離");
});

test("the shared worktree message asks to move to another worktree", () => {
  expect(SHARED_WORKTREE_MESSAGE).toContain("共有");
  expect(SHARED_WORKTREE_MESSAGE).toContain("EnterWorktree");
});
