import { expect, test } from "claude-code/testing";

import { sleepDenyReason } from "../hooks/background-over-sleep";
import { dedicatedToolsHint } from "../hooks/dedicated-tools";
import { bareRunnerHint } from "../hooks/mise-exec";
import { pueueCommandDetected } from "../hooks/pueue-guard";
import { rustParallelHint } from "../hooks/rust-parallel";

// 元スクリプトの grep と sed は行ごとに処理する。いずれも macOS で元スクリプトを実行した結果に合わせている

test("sleep と秒数が改行で分かれていれば拒否しない", () => {
  expect(sleepDenyReason("cat <<EOF\nsleep\n5\nEOF")).toBeNull();
});

test("複数行にまたがるクォートは除去せず、中の sleep を拒否する", () => {
  expect(sleepDenyReason('echo "start\nsleep 5\nend"')).not.toBeNull();
});

test("-r の直後に空白が無い grep も単一ファイル向けのヒントを出さない", () => {
  expect(dedicatedToolsHint("grep -r2 pattern src/a.ts")).toBeNull();
});

test("for と do が改行で分かれていればヒントを出さない", () => {
  expect(rustParallelHint('for f in a b; do\n prettier "$f"; done')).toBeNull();
});

test("複数行にまたがるクォートの中の pnpm にもヒントを出す", () => {
  expect(bareRunnerHint('echo "start\npnpm install\nend"')).toContain(
    "mise exec 推奨",
  );
});

test("行末の pnpm と pueue は後ろの改行を空白とみなさない", () => {
  expect(bareRunnerHint("pnpm\ninstall")).toBeNull();
  expect(pueueCommandDetected("pueue\nstatus")).toBe(false);
});
