import type { On } from "claude-code";

import { withContext } from "./pretool";
import { dedicatedToolsHint } from "./dedicated-tools";
import { sleepDenyReason } from "./background-over-sleep";
import { rustParallelHint } from "./rust-parallel";
import { bareRunnerHint } from "./mise-exec";
import { PUEUE_MESSAGE, pueueCommandDetected } from "./pueue-guard";

// settings.json での実行順（prefer-dedicated-tools → prefer-background-over-sleep
// → suggest-rust-parallel → prefer-mise-exec → pueue-daemon-guard）を保つ。
export function register(on: On) {
  on("classic.PreToolUse", { tool: "Bash" }, ($, e, next) => {
    const hint = e.tool === "Bash" ? dedicatedToolsHint(e.command) : null;
    return hint === null
      ? next(e)
      : next(e).then((result) => withContext(result, hint));
  });

  on("classic.PreToolUse", { tool: "Bash" }, ($, e, next) => {
    const reason = e.tool === "Bash" ? sleepDenyReason(e.command) : null;
    return reason === null ? next(e) : { deny: reason };
  });

  on("classic.PreToolUse", { tool: "Bash" }, ($, e, next) => {
    const hint = e.tool === "Bash" ? rustParallelHint(e.command) : null;
    return hint === null
      ? next(e)
      : next(e).then((result) => withContext(result, hint));
  });

  on("classic.PreToolUse", { tool: "Bash" }, async ($, e, next) => {
    const hint = e.tool === "Bash" ? bareRunnerHint(e.command) : null;
    if (hint === null) return next(e);

    // git リポジトリ外、またはルートに mise.toml / .mise.toml が無ければ何もしない
    const rootRun = await $.process
      .run(["git", "rev-parse", "--show-toplevel"], { timeoutMs: 3000 })
      .catch(() => null);
    const root =
      rootRun !== null && rootRun.exitCode === 0 ? rootRun.stdout.trim() : "";
    if (root === "") return next(e);

    // 元スクリプトの -f と同じく、通常のファイルのときだけ mise の設定とみなす
    const [hasMise, hasDotMise] = await Promise.all([
      $.fs
        .stat(`${root}/mise.toml`)
        .then((s) => s.kind === "file")
        .catch(() => false),
      $.fs
        .stat(`${root}/.mise.toml`)
        .then((s) => s.kind === "file")
        .catch(() => false),
    ]);
    return hasMise || hasDotMise ? withContext(await next(e), hint) : next(e);
  });

  on("classic.PreToolUse", { tool: "Bash" }, async ($, e, next) => {
    if (e.tool !== "Bash" || !pueueCommandDetected(e.command)) return next(e);

    // シェル組み込みの command -v の代わりに which で PATH 上の有無を確かめる
    const which = await $.process
      .run(["which", "pueue"], { timeoutMs: 3000 })
      .catch(() => null);
    if (which === null || which.exitCode !== 0) return next(e);

    const status = await $.process
      .run(["pueue", "status"], { timeoutMs: 3000 })
      .catch(() => null);
    return status !== null && status.exitCode === 0
      ? next(e)
      : withContext(await next(e), PUEUE_MESSAGE);
  });
}
