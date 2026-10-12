import { test, expect } from "claude-code/testing";

import { dedicatedToolsHint } from "../hooks/dedicated-tools";

test("cat suggests Read", () => {
  expect(dedicatedToolsHint("cat foo.txt")).toContain("Read ツール推奨");
});

test("cat redirect is real Bash usage, not flagged", () => {
  expect(dedicatedToolsHint("cat foo.txt > bar.txt")).toBeNull();
});

test("cat inside docker exec is not flagged (not a leading command)", () => {
  expect(dedicatedToolsHint("docker exec container cat /etc/hosts")).toBeNull();
});

test("head/tail also suggest Read", () => {
  expect(dedicatedToolsHint("head -n 50 foo.txt")).toContain("Read ツール推奨");
  expect(dedicatedToolsHint("tail -f foo.txt")).toContain("Read ツール推奨");
});

test("sed -n range suggests Read offset/limit", () => {
  expect(dedicatedToolsHint("sed -n '10,20p' foo.txt")).toContain(
    "offset/limit",
  );
});

test("sed -i suggests Edit", () => {
  expect(dedicatedToolsHint("sed -i 's/old/new/g' foo.txt")).toContain(
    "Edit ツール推奨",
  );
});

test("grep -r suggests Grep", () => {
  expect(dedicatedToolsHint('grep -r "pattern" src/')).toContain(
    "Grep ツール推奨",
  );
});

test("rg suggests Grep", () => {
  expect(dedicatedToolsHint('rg "pattern" src/')).toContain("Grep ツール推奨");
});

test("grep on a single file suggests Grep", () => {
  expect(dedicatedToolsHint("grep pattern src/index.ts")).toContain(
    "Grep ツール推奨",
  );
});

test("grep piped from stdin is not flagged (pipe input excluded)", () => {
  expect(dedicatedToolsHint("git log | grep fix")).toBeNull();
});

test("find suggests Glob", () => {
  expect(dedicatedToolsHint('find . -name "*.ts"')).toContain(
    "Glob ツール推奨",
  );
});

test("find -exec is not flagged (complex action)", () => {
  expect(dedicatedToolsHint('find . -name "*.tmp" -exec rm {} \\;')).toBeNull();
});

test("heredoc segments are skipped", () => {
  expect(dedicatedToolsHint("cat <<'EOF'\nhello\nEOF")).toBeNull();
});

test("plain commands are silent", () => {
  expect(dedicatedToolsHint("git status")).toBeNull();
});

test("hints are capped at 5", () => {
  const command = [
    "cat a.txt",
    "head b.txt",
    "tail c.txt",
    "sed -n '1,2p' d.txt",
    "sed -i s/a/b/ e.txt",
    "grep -r x src/",
  ].join(";");
  const hint = dedicatedToolsHint(command);
  expect(hint).not.toBeNull();
  expect((hint ?? "").split("\n").length).toBeLessThanOrEqual(5);
});

test("only the first segment is checked, as in the shell hook", () => {
  expect(dedicatedToolsHint("cd /tmp && cat a.txt")).toBeNull();
  expect(dedicatedToolsHint("echo x\ncat a.txt")).toBeNull();
  expect(dedicatedToolsHint("cat a.txt && echo done")).toContain(
    "Read ツール推奨",
  );
});
