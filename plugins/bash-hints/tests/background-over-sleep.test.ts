import { test, expect } from "claude-code/testing";

import { sleepDenyReason } from "../hooks/background-over-sleep";

test("sleep over 2 seconds is denied", () => {
  const reason = sleepDenyReason("sleep 5");
  expect(reason).not.toBeNull();
  expect(reason ?? "").toContain("run_in_background");
});

test("sleep of exactly 2 seconds is allowed", () => {
  expect(sleepDenyReason("sleep 2")).toBeNull();
});

test("short sleep (<= 2s) is allowed", () => {
  expect(sleepDenyReason("sleep 1")).toBeNull();
  expect(sleepDenyReason("sleep 0.5")).toBeNull();
});

test("fractional sleep over 2 seconds is denied", () => {
  expect(sleepDenyReason("sleep 2.5")).not.toBeNull();
});

test("sleep inside a quoted string is not a real sleep call", () => {
  expect(sleepDenyReason('echo "sleep 10"')).toBeNull();
});

test("sleep chained after other commands is still detected", () => {
  expect(sleepDenyReason("echo hi && sleep 30")).not.toBeNull();
});

test("no sleep at all is silent", () => {
  expect(sleepDenyReason("git status")).toBeNull();
});

test("a short sleep does not hide a later long sleep", () => {
  expect(sleepDenyReason("sleep 1 && sleep 300")).not.toBeNull();
  expect(sleepDenyReason("sleep 1 && sleep 2")).toBeNull();
});

test("sleep in a comment is not a real sleep call", () => {
  expect(sleepDenyReason("echo done # sleep 30")).toBeNull();
  expect(sleepDenyReason("echo ${#x}; sleep 30")).not.toBeNull();
});

test("sleep inside a heredoc body is not a real sleep call", () => {
  expect(sleepDenyReason("cat > run.sh <<'EOF'\nsleep 30\nEOF")).toBeNull();
  expect(sleepDenyReason("cat <<EOF\nhi\nEOF\nsleep 30")).not.toBeNull();
});
