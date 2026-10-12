import { expect, test } from "claude-code/testing";

import { rustParallelHint } from "../hooks/rust-parallel";

// hooks/tests/suggest-rust-parallel.test.sh の移植
const expectHint = (name: string, command: string, cmd: string) =>
  test(name, () => {
    expect(rustParallelHint(command) ?? "").toContain(`rust-parallel ${cmd}`);
  });

const expectSilent = (name: string, command: string) =>
  test(name, () => {
    expect(rustParallelHint(command)).toBeNull();
  });

expectHint(
  "plain && chain",
  "eslint a.ts && eslint b.ts && eslint c.ts",
  "eslint",
);
expectHint(
  "for loop with command",
  'for f in src/*.ts; do prettier --check "$f"; done',
  "prettier",
);
expectSilent("python -c string", 'python3 -c "import a; import b; import c"');
expectSilent(
  "&& inside double quotes",
  'gh issue create -b "x && y && z && w"',
);
expectSilent(
  "&& inside heredoc",
  "cat <<'EOF'\nif a && b && c && d; then echo; fi\nEOF",
);
expectSilent(
  "for loop assignment body",
  'for f in a b c; do d=$(awk "{print}" "$f"); echo "$d"; done',
);
expectSilent("single command", "git status");

test("chain count and hint text match the shell output", () => {
  expect(rustParallelHint("eslint a && eslint b && eslint c && eslint d")).toBe(
    "【rust-parallel 推奨】`eslint` が 4 回の `&&` チェーンで検出されました。独立しているなら並列化できます:\n  printf 'arg1\\narg2\\narg3\\n' | rust-parallel eslint",
  );
});

test("newlines split segments like the shell read loop", () => {
  expect(rustParallelHint("eslint a\neslint b\neslint c")).toContain(
    "rust-parallel eslint",
  );
});
